import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildHtml } from "./webview/panel";
import { parseManifest } from "./host/manifest";
import { findProjectRoot } from "./host/projectRoot";
import { contextValueForEditor } from "./host/context";
import { saveExport } from "./host/exportSave";
import { makeCompileTask, runTaskToCompletion, makeCompileSelectTask } from "./host/compile";
import { startDbtRunWithSeed, type RunController } from "./host/run";
import { readCompiledSql, readModelSql, compiledDocUri, parseCompiledDocQuery } from "./host/compiledSql";
import { tokenizeCommand, buildGistPrompt, runGist } from "./host/gist";
import { resolveInProject } from "./host/projectFs";
import { runColumnLineageForProject } from "./host/columnLineage";
import type { Graph, GraphNode } from "@dbt-open-lineage/core";

const VIEW_ID = "dbtOpenLineage.graph";

let view: vscode.Webview | undefined; // the resolved panel view's webview
let projectRoot: string | undefined;
let lastGraph: Graph | undefined;
let activeRun: RunController | undefined; // set while a dbt.run is in flight; guards against overlapping runs
let runOutputChannel: vscode.OutputChannel | undefined;

// A dedicated Output channel (not vscode.window.createTerminal) so a run
// shows up under the OUTPUT tab, not TERMINAL — the extension host's focus
// shouldn't get yanked onto a shell tab every time a run starts.
function getRunOutputChannel(): vscode.OutputChannel {
  if (!runOutputChannel) runOutputChannel = vscode.window.createOutputChannel("dbt Open Lineage");
  return runOutputChannel;
}

const COMPILED_SCHEME = "dbt-compiled";
const compiledContent = new Map<string, string>(); // uri.toString() -> compiled SQL
const compiledChanged = new vscode.EventEmitter<vscode.Uri>();
let graphCache: { root: string; mtimeMs: number; graph: Graph } | undefined;

function resolveRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration("dbt-open-lineage").get<string>("projectRoot");
  if (configured) return configured;
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const start = active ? path.dirname(active) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!start) return undefined;
  return findProjectRoot(start, (p) => fs.existsSync(p)) ?? start;
}

// Parse target/manifest.json once per manifest write — cheap enough for the
// per-editor-switch context-key update. Invalidated by mtime.
function loadGraph(root: string): Graph | undefined {
  const p = path.join(root, "target", "manifest.json");
  try {
    const st = fs.statSync(p);
    if (!graphCache || graphCache.mtimeMs !== st.mtimeMs || graphCache.root !== root) {
      graphCache = { root, mtimeMs: st.mtimeMs, graph: parseManifest(fs.readFileSync(p, "utf8")) };
    }
    return graphCache.graph;
  } catch {
    return undefined;
  }
}

// The dbt model node for the active editor, or undefined. Matches the file's
// project-relative path to GraphNode.path; returns the node's unique id + name.
function activeModelNode(): { root: string; node: GraphNode } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || path.extname(ed.document.uri.fsPath) !== ".sql") return undefined;
  const root = resolveRoot();
  if (!root) return undefined;
  const graph = loadGraph(root);
  if (!graph) return undefined;
  const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
  const node = graph.nodes.find((n) => n.path === rel);
  return node ? { root, node } : undefined;
}

class CompiledSqlProvider implements vscode.TextDocumentContentProvider {
  readonly onDidChange = compiledChanged.event;
  provideTextDocumentContent(uri: vscode.Uri): string {
    return compiledContent.get(uri.toString()) ?? "";
  }
}

function assetFile(extensionUri: vscode.Uri, ext: string): string | undefined {
  const dir = path.join(extensionUri.fsPath, "media", "assets");
  try {
    return fs.readdirSync(dir).find((f: string) => f.endsWith(ext));
  } catch {
    return undefined;
  }
}

async function handleMessage(msg: { id: number; cmd: string; args: Record<string, unknown> }) {
  if (!view) return;
  const reply = (body: object) => view!.postMessage({ id: msg.id, ...body });
  try {
    switch (msg.cmd) {
      case "dbt.manifest": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const p = path.join(projectRoot, "target", "manifest.json");
        if (!fs.existsSync(p)) throw new Error(`no manifest at ${p} — run \`dbt compile\``);
        const graph: Graph = parseManifest(fs.readFileSync(p, "utf8"));
        lastGraph = graph;
        reply({ ok: true, result: graph });
        break;
      }
      case "dbt.compile": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const code = await runTaskToCompletion(makeCompileTask(projectRoot), {
          executeTask: (t) => vscode.tasks.executeTask(t),
          onDidEndTaskProcess: (cb) => vscode.tasks.onDidEndTaskProcess(cb),
        });
        if (code !== 0) throw new Error(`dbt compile failed (exit ${code})`);
        const p = path.join(projectRoot, "target", "manifest.json");
        const graph: Graph = parseManifest(fs.readFileSync(p, "utf8"));
        lastGraph = graph;
        reply({ ok: true, result: graph });
        break;
      }
      case "dbt.run": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        if (activeRun) throw new Error("a run is already in progress");
        const root = projectRoot;
        const command = String(msg.args.command ?? "run") as "run" | "build" | "test";
        const selector = String(msg.args.selector ?? "");
        const hasSeed = msg.args.hasSeed === true;
        const hasFullRefresh = msg.args.hasFullRefresh === true;
        if (!selector.trim()) throw new Error("no runnable models in current view");
        const channel = getRunOutputChannel();
        // Fresh view per run (a stale prior run's output doesn't linger).
        // Deliberately NOT calling channel.show() — a run must never yank
        // the user's active panel/tab over to Output, the same complaint
        // that ruled out vscode.Task/Pseudoterminal (which forced Terminal).
        // The channel still exists and accumulates output; open it from the
        // Output dropdown ("dbt Open Lineage") if you want to watch it live.
        channel.clear();
        // TEMPORARY diagnostic (2026-07-15): appendLine isn't showing in the
        // Output panel despite the run genuinely executing (pilot lights
        // update correctly). Mirroring to console.log — visible via Help >
        // Toggle Developer Tools > Console — to confirm whether appendLine
        // is actually being called with real content, or whether this is a
        // VSCode Output-panel rendering issue unrelated to our code. Remove
        // once diagnosed.
        console.log("[dbt-open-lineage] output channel:", `> dbt ${command} --select ${selector}`);
        channel.appendLine(`> dbt ${command} --select ${selector}`);
        activeRun = startDbtRunWithSeed(root, command, selector, hasSeed, hasFullRefresh, {
          onWrite: (text) => {
            console.log("[dbt-open-lineage] output channel:", text);
            channel.appendLine(text);
          },
          onEvent: (event) => {
            view?.postMessage({ evt: "run", event });
            if (event.type === "done") activeRun = undefined;
          },
        });
        reply({ ok: true, result: true });
        break;
      }
      case "dbt.cancel": {
        activeRun?.cancel();
        reply({ ok: true, result: true });
        break;
      }
      case "ide.open": {
        if (!projectRoot) throw new Error("no dbt project");
        const rel = String(msg.args.path ?? "");
        const uri = vscode.Uri.file(path.join(projectRoot, rel));
        await vscode.window.showTextDocument(uri, { preview: false });
        reply({ ok: true, result: true });
        break;
      }
      case "export.save": {
        const filename = String(msg.args.filename ?? "export.txt");
        const dataB64 = String(msg.args.dataB64 ?? "");
        const ok = await saveExport(filename, dataB64, {
          pick: async (name) => {
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name) });
            return uri?.fsPath;
          },
          write: async (p, bytes) => { await vscode.workspace.fs.writeFile(vscode.Uri.file(p), bytes); },
        });
        reply({ ok: true, result: ok });
        break;
      }
      case "fs.readText": {
        if (!projectRoot) throw new Error("no dbt project");
        const abs = resolveInProject(projectRoot, String(msg.args.path ?? ""));
        const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
        reply({ ok: true, result: text });
        break;
      }
      case "fs.writeText": {
        if (!projectRoot) throw new Error("no dbt project");
        const abs = resolveInProject(projectRoot, String(msg.args.path ?? ""));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(msg.args.text ?? ""), "utf8");
        reply({ ok: true, result: true });
        break;
      }
      case "dbt.gist": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const id = String(msg.args.uniqueId ?? "");
        const node = (lastGraph ?? parseManifest(fs.readFileSync(path.join(projectRoot, "target", "manifest.json"), "utf8")))
          .nodes.find((n) => n.id === id);
        if (!node) throw new Error(`unknown model: ${id}`);
        const cfg = vscode.workspace.getConfiguration("dbt-open-lineage");
        const command = cfg.get<string>("ai.command") || 'claude -p "{prompt}"';
        const { sql } = readCompiledSql(projectRoot, id);
        const prompt = buildGistPrompt(node.name, String(msg.args.description ?? node.description), sql);
        const gist = await runGist(tokenizeCommand(command, prompt));
        reply({ ok: true, result: gist });
        break;
      }
      case "dbt.columnLineage": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const payload = await runColumnLineageForProject(projectRoot);
        reply({ ok: true, result: payload });
        break;
      }
      case "dbt.modelSql": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const id = String(msg.args.id ?? "");
        if (!id) throw new Error("dbt.modelSql: missing node id");
        reply({ ok: true, result: readModelSql(projectRoot, id) });
        break;
      }
      default:
        reply({ ok: false, error: `unknown command: ${msg.cmd}` });
    }
  } catch (e) {
    reply({ ok: false, error: String((e as Error).message ?? e) });
  }
}

class LineageViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const wv = webviewView.webview;
    wv.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    // Validate the built assets BEFORE rendering — media/ is gitignored, so on
    // an unbuilt clone show a clear message instead of a blank graph.
    const jsFile = assetFile(this.extensionUri, ".js");
    const cssFile = assetFile(this.extensionUri, ".css");
    if (!jsFile || !cssFile) {
      wv.html = `<!doctype html><body style="font:13px sans-serif;padding:12px;color:#ccc;background:#1e1e1e">dbt Open Lineage: run the build first (media/assets missing). Run <code>npm run build</code>.</body>`;
      return;
    }

    projectRoot = resolveRoot();
    const assetsDir = vscode.Uri.joinPath(this.extensionUri, "media", "assets");
    const js = wv.asWebviewUri(vscode.Uri.joinPath(assetsDir, jsFile));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(assetsDir, cssFile));
    wv.html = buildHtml(wv, js, css, { projectPath: projectRoot ?? "", initialSelector: "" });

    view = wv;
    const sub = wv.onDidReceiveMessage(handleMessage);
    const editorSub = vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!view || !ed || !projectRoot || !lastGraph) return;
      const val = contextValueForEditor(lastGraph, projectRoot, ed.document.uri.fsPath);
      if (val) view.postMessage({ evt: "context", value: val });
    });

    // Watch target/manifest.json so an EXTERNAL `dbt compile` (terminal, CI
    // task…) refreshes the DAG without a window reload. Debounced: dbt may
    // fire create+change (or partial-write double events) for one compile —
    // collapse them into one push. The webview refetches via dbt.manifest on
    // receipt (see core's onManifestChanged effect).
    let manifestTimer: ReturnType<typeof setTimeout> | undefined;
    const pushManifestChanged = () => {
      clearTimeout(manifestTimer);
      manifestTimer = setTimeout(() => { void view?.postMessage({ evt: "manifestChanged" }); }, 500);
    };
    const watcher = projectRoot
      ? vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(projectRoot, "target/manifest.json"),
        )
      : undefined;
    watcher?.onDidChange(pushManifestChanged);
    watcher?.onDidCreate(pushManifestChanged);

    webviewView.onDidDispose(() => {
      sub.dispose();
      editorSub.dispose();
      watcher?.dispose();
      clearTimeout(manifestTimer);
      view = undefined;
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new LineageViewProvider(context.extensionUri);

  const setModelCtx = () => {
    void vscode.commands.executeCommand(
      "setContext", "dbtOpenLineage.activeIsModel", activeModelNode() !== undefined,
    );
  };
  setModelCtx();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("dbt-open-lineage.open", () => {
      void vscode.commands.executeCommand("dbtOpenLineage.graph.focus");
    }),
    vscode.workspace.registerTextDocumentContentProvider(COMPILED_SCHEME, new CompiledSqlProvider()),
    compiledChanged,
    vscode.window.onDidChangeActiveTextEditor(setModelCtx),
    vscode.commands.registerCommand("dbt-open-lineage.compile", async () => {
      const m = activeModelNode();
      if (!m) {
        void vscode.window.showInformationMessage(
          "Compile: active file is not a dbt model (or no manifest — run `dbt compile`).",
        );
        return;
      }
      const { sql, compiled } = readCompiledSql(m.root, m.node.id);
      const uri = vscode.Uri.parse(compiledDocUri(m.node.name, m.node.id, m.root));
      compiledContent.set(
        uri.toString(),
        compiled ? sql : `-- ${m.node.name}: no compiled_code yet. Run "dbt: Recompile Model".`,
      );
      compiledChanged.fire(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, "sql");
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside, preview: false,
      });
    }),
    vscode.commands.registerCommand("dbt-open-lineage.recompile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.scheme !== COMPILED_SCHEME) return;
      const uri = ed.document.uri;
      // root travels with the uri (see compiledDocUri) rather than being
      // re-derived from activeTextEditor — which right here IS this virtual
      // doc, so resolveRoot() would silently resolve to "/" and point dbt at
      // the wrong cwd.
      const { id, root } = parseCompiledDocQuery(uri.query);
      const name = path.basename(uri.path).replace(/\.sql$/, "");
      if (!root) { void vscode.window.showErrorMessage("no dbt project found"); return; }
      // Running feedback: a notification spinner "Recompiling <model>…" for the
      // duration of the dbt task (native parity for Mnemo's amber note).
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Recompiling ${name}…`, cancellable: false },
        () => runTaskToCompletion(makeCompileSelectTask(root, name), {
          executeTask: (t) => vscode.tasks.executeTask(t),
          onDidEndTaskProcess: (cb) => vscode.tasks.onDidEndTaskProcess(cb),
        }),
      );
      if (code !== 0) { void vscode.window.showErrorMessage(`dbt compile failed (exit ${code})`); return; }
      const { sql, compiled } = readCompiledSql(root, id);
      compiledContent.set(uri.toString(), compiled ? sql : `-- ${name}: still no compiled_code.`);
      compiledChanged.fire(uri);
      // Transient success confirmation (parity with Mnemo's "✓ Compiled — up to date").
      vscode.window.setStatusBarMessage("$(check) Compiled — up to date", 2500);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === COMPILED_SCHEME) compiledContent.delete(doc.uri.toString());
    }),
  );
}

export function deactivate() {}
