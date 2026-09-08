import { LineBuffer, defaultDeps, type RunDeps } from "./run";

/** `dbt ls --select <expr> --state <dir>` restricted to the four resource
 * types the DAG shows, emitting one JSON object per matched node with just its
 * unique_id (which maps directly onto graph node ids). */
export function buildLsArgs(select: string, state: string): string[] {
  return [
    "ls", "--select", select, "--state", state,
    "--resource-type", "model", "snapshot", "seed", "source",
    "--output", "json", "--output-keys", "unique_id",
  ];
}

/** Parse `dbt ls --output json --output-keys unique_id` stdout lines into node
 * ids. Each line is its own JSON object; a blank or malformed line (partial
 * write, non-JSON noise) is skipped rather than thrown on. */
export function parseLsUniqueIds(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { unique_id?: unknown };
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
      const tail = errLines.filter((l) => l.trim()).slice(-3).join(" ").trim();
      reject(new Error(tail || `dbt ls failed (exit ${code ?? -1})`));
    });
    child.on("error", (e: Error) => { if (done) return; done = true; reject(e); });
  });
}
