import { LineBuffer, defaultDeps, type RunDeps } from "./run";

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function cleanLine(line: string): string {
  return line.replace(ANSI_ESCAPE, "").trim();
}

/** dbt frequently writes structured log events to stdout, including fatal
 * parse/profile errors. Convert those records back to their human message so
 * a failed state selector explains itself in the compact toolbar error. */
function readableLine(line: string): string {
  const clean = cleanLine(line);
  if (!clean) return "";
  try {
    const obj = JSON.parse(clean) as { info?: { msg?: unknown } };
    if (typeof obj.info?.msg === "string") return obj.info.msg;
  } catch { /* plain-text dbt output */ }
  return clean;
}

/** `dbt ls --select <expr> --state <dir>` restricted to the four resource
 * types the DAG shows, emitting one JSON object per matched node with just its
 * unique_id (which maps directly onto graph node ids). `select` may still
 * contain an embedded `--exclude <expr>` clause (parseRunFlags only strips
 * --full-refresh/--defer/--state, not --exclude); dbt space-splits a
 * --select value into selector specs, so leaving --exclude inline would turn
 * the exclusion into a UNION instead. Mirrors resolveSelector in
 * packages/core/src/selector.ts: split on --exclude, union any remaining
 * chunks (dropping blanks, e.g. a bare trailing --exclude) into one discrete
 * --exclude arg. */
export function buildLsArgs(select: string, state: string): string[] {
  const chunks = select.split(/\s*--exclude\b\s*/);
  const include = chunks[0].trim();
  const exclude = chunks.slice(1).map((c) => c.trim()).filter(Boolean).join(" ");
  const args = ["ls", "--select", include];
  if (exclude) args.push("--exclude", exclude);
  args.push(
    "--state", state,
    "--resource-type", "model", "snapshot", "seed", "source",
    "--output", "json", "--output-keys", "unique_id",
  );
  return args;
}

/** Parse `dbt ls --output json --output-keys unique_id` stdout lines into node
 * ids. Each line is its own JSON object; a blank or malformed line (partial
 * write, non-JSON noise) is skipped rather than thrown on. */
export function parseLsUniqueIds(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const clean = cleanLine(line);
    if (!clean) continue;
    try {
      const obj = JSON.parse(clean) as { unique_id?: unknown };
      if (typeof obj.unique_id === "string") ids.push(obj.unique_id);
    } catch { /* non-JSON line — ignore */ }
  }
  return ids;
}

/** Run `dbt ls` to completion in `projectRoot`, collecting stdout and
 * resolving the matched node ids. Rejects with the stderr tail (or a generic
 * exit-code message) when dbt exits non-zero — e.g. a missing/invalid --state
 * dir or absent prior manifest. */
export function runDbtLs(
  projectRoot: string, select: string, state: string, deps: RunDeps = defaultDeps,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = deps.spawn(projectRoot, buildLsArgs(select, state));
    const out = new LineBuffer();
    const err = new LineBuffer();
    const outLines: string[] = [];
    const errLines: string[] = [];
    let done = false;

    child.stdout?.on("data", (c: Buffer) => { for (const l of out.push(c.toString("utf8"))) outLines.push(l); });
    child.stderr?.on("data", (c: Buffer) => { for (const l of err.push(c.toString("utf8"))) errLines.push(l); });
    child.on("close", (code: number | null) => {
      if (done) return; done = true;
      for (const l of out.flush()) outLines.push(l);
      for (const l of err.flush()) errLines.push(l);
      if ((code ?? -1) === 0) { resolve(parseLsUniqueIds(outLines)); return; }
      // Click/dbt writes several runtime and usage failures to stdout rather
      // than stderr. Prefer stderr when present, otherwise surface stdout;
      // never reduce a useful dbt error to only "exit 2" again.
      const source = errLines.some((l) => cleanLine(l)) ? errLines : outLines;
      const tail = source.map(readableLine).filter(Boolean).slice(-6).join(" ").trim();
      reject(new Error(tail || `dbt ls failed (exit ${code ?? -1})`));
    });
    child.on("error", (e: Error) => { if (done) return; done = true; reject(e); });
  });
}
