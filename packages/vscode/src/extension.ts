import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildHtml } from "./webview/panel";
import { parseManifest } from "./host/manifest";
import { nodeForFile, resolveProjectRoot } from "./host/projectRoot";
import { contextValueForEditor } from "./host/context";
import { saveExport } from "./host/exportSave";
import { startDbtRunWithSeed, spawnDbtToCompletion, type RunController } from "./host/run";
import { runDbtLs } from "./host/ls";
import { readCompiledSql, readModelSql, compiledDocUri, parseCompiledDocQuery, analysisNodeFromManifest } from "./host/compiledSql";
import { tokenizeCommand, buildGistPrompt, runGist } from "./host/gist";
import { resolveInProject } from "./host/projectFs";
import { runColumnLineageForProject } from "./host/columnLineage";
import { readStableArtifact } from "./host/stableArtifact";
import type { Graph, GraphNode } from "@dbt-open-lineage/core";

const VIEW_ID = "dbtOpenLineage.graph";

let view: vscode.Webview | undefined; // the resolved panel view's webview
let projectRoot: string | undefined;
let lastGraph: Graph | undefined;
let activeRun: RunController | undefined; // set while a dbt.run is in flight; guards against overlapping runs
let runOutputChannel: vscode.OutputChannel | undefined;
let extensionRoot: string | undefined;

let manifestWatcher: vscode.FileSystemWatcher | undefined;
let manifestWatchRoot: string | undefined; // absolute root the current watcher is pinned to
let manifestTimer: ReturnType<typeof setTimeout> | undefined;

// Debounced push: dbt may fire create+change (or a partial-write double event)
// for one compile — collapse them into one message. The webview refetches via
// dbt.manifest on receipt (see core's onManifestChanged effect).
function pushManifestChanged(): void {
  clearTimeout(manifestTimer);
  manifestTimer = setTimeout(() => { void view?.postMessage({ evt: "manifestChanged" }); }, 500);
}

// (Re)build the target/manifest.json watcher for `root` so an EXTERNAL `dbt
// compile` (terminal, CI) refreshes the DAG without a window reload. Called on
// EVERY graph load (dbt.manifest/dbt.compile), not just at panel-open, because
// resolveRoot() can return undefined at first paint (workspace still loading)
// or change later (multi-root) — a watcher pinned to the panel-open value
// would then watch nothing, or the wrong project's manifest. No-ops when the
// root is unchanged so repeat loads don't churn the watcher.
function ensureManifestWatcher(root: string | undefined): void {
  if (root === manifestWatchRoot) return;
  manifestWatcher?.dispose();
  manifestWatchRoot = root;
  if (!root) { manifestWatcher = undefined; return; }
  manifestWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, "target/manifest.json"),
  );
  manifestWatcher.onDidChange(pushManifestChanged);
  manifestWatcher.onDidCreate(pushManifestChanged);
}

function disposeManifestWatcher(): void {
  manifestWatcher?.dispose();
  manifestWatcher = undefined;
  manifestWatchRoot = undefined;
  clearTimeout(manifestTimer);
}

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

function resolveRoot(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): string | undefined {
  const configured = vscode.workspace.getConfiguration("dbt-open-lineage").get<string>("projectRoot");
  if (configured) return configured;
  // Only a real on-disk file can seed the root. A virtual/readonly doc (the
  // `dbt-compiled:` preview, a git-diff, a remote scheme) has a fabricated
  // fsPath — trusting it resolved to bogus roots like `/temp/readonly/target`.
  const ed = editor;
  const activeFileDir = ed && ed.document.uri.scheme === "file"
    ? path.dirname(ed.document.uri.fsPath) : undefined;
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === "file")
    .map((f) => f.uri.fsPath);
  return resolveProjectRoot({
    activeFileDir,
    workspaceFolders,
    exists: (p) => fs.existsSync(p),
    listDirs: (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory()
            && d.name !== "node_modules" && d.name !== "dbt_packages"
            && d.name !== "target" && !d.name.startsWith("."))
          .map((d) => path.join(dir, d.name));
      } catch { return []; }
    },
  });
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

/** Push the editor's dbt model to the webview.
 *
 * Resolve the root and graph from the editor at the time of the event instead
 * of relying on the panel's asynchronously initialized globals. Previously a
 * file opened while `dbt.manifest` was still loading was silently discarded
 * because `projectRoot`/`lastGraph` were undefined, and no later event replayed
 * it. That race is much easier to hit on a slower Windows extension host. */
function pushEditorContext(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
  if (!view || !editor || editor.document.uri.scheme !== "file") return;
  if (path.extname(editor.document.uri.fsPath).toLowerCase() !== ".sql") return;

  const root = resolveRoot(editor);
  if (!root) return;
  const graph = loadGraph(root);
  if (!graph) return;
  const value = contextValueForEditor(graph, root, editor.document.uri.fsPath);
  if (!value) return;

  projectRoot = root;
  lastGraph = graph;
  ensureManifestWatcher(root);
  void view.postMessage({ evt: "context", value });
}

// The dbt model node for the active editor, or undefined. Matches the file's
// project-relative path to GraphNode.path; returns the node's unique id + name.
function activeModelNode(): { root: string; node: GraphNode } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file" || path.extname(ed.document.uri.fsPath).toLowerCase() !== ".sql") return undefined;
  const root = resolveRoot(ed);
  if (!root) return undefined;
  const graph = loadGraph(root);
  if (!graph) return undefined;
  const node = nodeForFile(graph, root, ed.document.uri.fsPath);
  return node ? { root, node } : undefined;
}

// Like activeModelNode, but also recognizes an ANALYSIS file (not in the DAG
// graph) by scanning the manifest. Used by the Compile commands + their context
// key so analyses (analyses/*.sql) can be compiled like models.
function activeCompilableNode(): { root: string; node: { id: string; name: string; path?: string } } | undefined {
  const m = activeModelNode();
  if (m) return m;
  const ed = vscode.window.activeTextEditor;
  if (!ed || path.extname(ed.document.uri.fsPath) !== ".sql" || ed.document.uri.scheme !== "file") return undefined;
  const root = resolveRoot();
  if (!root) return undefined;
  const p = path.join(root, "target", "manifest.json");
  if (!fs.existsSync(p)) return undefined;
  const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
  const node = analysisNodeFromManifest(fs.readFileSync(p, "utf8"), rel);
  return node ? { root, node } : undefined;
}

/** Refresh the editor-title Compile command's `when` context. This must run
 * after manifest loading as well as on editor changes: an editor event that
 * arrives before the graph is available otherwise leaves the command hidden
 * for the rest of the session. */
function updateCompilableContext(): void {
  void vscode.commands.executeCommand(
    "setContext", "dbtOpenLineage.activeIsCompilable", activeCompilableNode() !== undefined,
  );
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
        ensureManifestWatcher(projectRoot); // re-pin the watcher to the freshly resolved root
        const p = path.join(projectRoot, "target", "manifest.json");
        if (!fs.existsSync(p)) throw new Error(`no manifest at ${p} — run \`dbt compile\``);
        const graph: Graph = await readStableArtifact(p, parseManifest);
        lastGraph = graph;
        reply({ ok: true, result: graph });
        // The active editor may have changed while the manifest request was in
        // flight. Replay it after the graph is ready so that early editor events
        // are never lost.
        pushEditorContext();
        updateCompilableContext();
        break;
      }
      case "dbt.compile": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        ensureManifestWatcher(projectRoot); // re-pin the watcher to the freshly resolved root
        const channel = getRunOutputChannel();
        channel.clear();
        channel.appendLine("> dbt compile");
        // Silent: spawn (no Task, no Terminal). Output goes to the "dbt Open
        // Lineage" channel; never .show() it — a compile must not yank focus.
        const code = await spawnDbtToCompletion(projectRoot, ["compile"], (l) => channel.appendLine(l));
        if (code !== 0) throw new Error(`dbt compile failed (exit ${code})`);
        const p = path.join(projectRoot, "target", "manifest.json");
        const graph: Graph = await readStableArtifact(p, parseManifest);
        lastGraph = graph;
        reply({ ok: true, result: graph });
        pushEditorContext();
        updateCompilableContext();
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
        // --defer / --state <dir>: run modifiers the webview extracted from the
        // selector box (parseRunFlags) and forwarded alongside the selector.
        const defer = msg.args.defer === true;
        const state = typeof msg.args.state === "string" ? msg.args.state : undefined;
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
        activeRun = startDbtRunWithSeed(root, command, selector, hasSeed, { fullRefresh: hasFullRefresh, defer, state }, {
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
      case "dbt.ls": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const select = String(msg.args.select ?? "");
        const state = typeof msg.args.state === "string" ? msg.args.state : "";
        if (!select.trim()) throw new Error("dbt.ls: missing select expression");
        if (!state.trim()) throw new Error("state: selectors need --state <dir>");
        const ids = await runDbtLs(projectRoot, select, state);
        reply({ ok: true, result: ids });
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
        const graph = lastGraph ?? await readStableArtifact(
          path.join(projectRoot, "target", "manifest.json"), parseManifest,
        );
        const node = graph
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
        if (!extensionRoot) throw new Error("extension installation path is unavailable");
        const nodeIds = Array.isArray(msg.args.nodeIds)
          ? [...new Set(msg.args.nodeIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
          : undefined;
        const cfg = vscode.workspace.getConfiguration("dbt-open-lineage");
        const inspectionTarget = cfg.get<string>("columnLineage.inspectionTarget") ?? "";
        const autoBuild = cfg.get<boolean>("columnLineage.autoBuild") ?? true;
        const refreshCatalog = cfg.get<boolean>("columnLineage.refreshCatalog") ?? true;
        const engine = cfg.get<"bundled" | "colibri">("columnLineage.engine") ?? "bundled";
        const channel = getRunOutputChannel();
        const payload = await runColumnLineageForProject(projectRoot, extensionRoot, {
          nodeIds,
          inspectionTarget,
          autoBuild,
          refreshCatalog,
          engine,
          onLog: (line) => channel.appendLine(line),
        });
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
    const editorSub = vscode.window.onDidChangeActiveTextEditor(pushEditorContext);

    // Best-effort watcher at panel-open; re-evaluated on every graph load (see
    // ensureManifestWatcher — the reliable point, since resolveRoot() may be
    // undefined here while the workspace is still loading).
    ensureManifestWatcher(projectRoot);

    webviewView.onDidDispose(() => {
      sub.dispose();
      editorSub.dispose();
      disposeManifestWatcher();
      view = undefined;
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionRoot = context.extensionUri.fsPath;
  const provider = new LineageViewProvider(context.extensionUri);

  updateCompilableContext();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("dbt-open-lineage.open", () => {
      void vscode.commands.executeCommand("dbtOpenLineage.graph.focus");
    }),
    vscode.workspace.registerTextDocumentContentProvider(COMPILED_SCHEME, new CompiledSqlProvider()),
    compiledChanged,
    vscode.window.onDidChangeActiveTextEditor(updateCompilableContext),
    vscode.commands.registerCommand("dbt-open-lineage.compile", async () => {
      const m = activeCompilableNode();
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
      // duration of the dbt compile (native parity for Mnemo's amber note).
      // Silent: spawn to the Output channel, never the Terminal (see dbt.compile).
      //
      // Analyses (id "analysis.*") aren't reliably selectable by `--select`
      // across dbt versions, so recompile them with a full `dbt compile` (which
      // always compiles analyses) rather than a targeted select. Models keep
      // the fast targeted compile.
      const isAnalysis = id.startsWith("analysis.");
      const args = isAnalysis ? ["compile"] : ["compile", "--select", name];
      const channel = getRunOutputChannel();
      channel.clear();
      channel.appendLine(`> dbt ${args.join(" ")}`);
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Recompiling ${name}…`, cancellable: false },
        () => spawnDbtToCompletion(root, args, (l) => channel.appendLine(l)),
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
