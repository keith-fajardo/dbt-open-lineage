import { execFile, execFileSync } from "child_process";

const MAX_SQL = 100_000; // keep total argv well under ARG_MAX

/** Resolve a bare command name (e.g. `claude`) to an absolute path.
 * An editor launched from the macOS Dock inherits a minimal PATH that omits
 * ~/.local/bin / Homebrew, so a bare `execFile("claude")` fails with ENOENT
 * even when installed — resolve it via the user's login shell instead. On
 * Windows, `where` serves the same purpose without needing a POSIX shell.
 * Commands already containing a path separator are used as-is; resolution
 * failure falls back to the original name. */
export function resolveBin(cmd: string): string {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("where", [cmd], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out) return out;
    } else {
      const shell = process.env.SHELL || "/bin/zsh";
      const out = execFileSync(shell, ["-lic", `command -v ${cmd}`], { encoding: "utf8" }).trim();
      if (out) return out;
    }
  } catch { /* not resolvable — fall back to the bare name */ }
  return cmd;
}

export interface SpawnResult { code: number; stdout: string; stderr: string }
export interface GistIo { spawn(argv: string[]): Promise<SpawnResult> }

/** Split a command template into argv, honoring single/double quotes, and
 * substitute `{prompt}` as exactly one argv element (never through a shell). */
export function tokenizeCommand(template: string, prompt: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    tokens.push(raw.replace(/\{prompt\}/g, prompt));
  }
  if (tokens.length === 0) throw new Error("empty command");
  return tokens;
}

export function buildGistPrompt(name: string, description: string, compiledSql: string): string {
  const sql = compiledSql.length > MAX_SQL ? compiledSql.slice(0, MAX_SQL) + "\n-- …truncated" : compiledSql;
  return [
    "Write a 1-2 sentence plain-English gist of what this dbt model's transformation does.",
    "Output only the gist itself — no preamble, no markdown, and no commentary about tasks, skills, or your process.",
    "If you list models or tables in sequence, separate them with '|' not '>'.",
    `Model: ${name}`,
    description ? `Current description: ${description}` : "",
    "Compiled SQL:",
    sql,
  ].filter(Boolean).join("\n");
}

/** `shell: true` on win32 is required for execFile to launch npm-installed
 * .cmd/.bat shims (Node cannot run them directly); Node quotes each argv
 * element itself in that mode, so {prompt} still can't break out into the
 * shell. No-op on macOS/Linux, which never needed a shell here. */
const nodeSpawn: GistIo["spawn"] = (argv) =>
  new Promise((resolve, reject) => {
    const opts = { maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" };
    execFile(resolveBin(argv[0]), argv.slice(1), opts, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") { reject(new Error(`command not found: ${argv[0]}`)); return; }
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });

/** Spawn the AI command (no shell) and return its trimmed stdout. */
export async function runGist(argv: string[], io: GistIo = { spawn: nodeSpawn }): Promise<string> {
  const { code, stdout, stderr } = await io.spawn(argv);
  if (code !== 0) throw new Error(`gist command failed (exit ${code}): ${stderr.trim() || "no stderr"}`);
  const out = stdout.trim();
  if (!out) throw new Error("gist command produced no output");
  return out;
}
