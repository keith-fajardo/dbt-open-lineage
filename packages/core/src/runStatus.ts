/** Per-node run outcome. Absence of an id from a status map means "idle" —
 * "idle" is deliberately not a member of this type, so a caller can't
 * accidentally treat "no entry yet" and "explicitly idle" as different
 * states. */
export type Status = "running" | "success" | "failed" | "skipped";

/** `Status` plus "queued" — a node the current run's selector includes but
 * whose dbt START event hasn't arrived yet. Unlike `Status`, this is
 * client-only: it never crosses the wire in a `RunEvent`, it's assigned
 * optimistically in the webview the moment a run is kicked off (before any
 * host event arrives), then overwritten by a real "running" once dbt's own
 * START line for that node comes in. Exists so "about to run, waiting its
 * turn" reads differently from "idle" (not part of this run at all) — both
 * would otherwise show as the same absent-from-the-map grey. */
export type RunDisplayStatus = Status | "queued";

/** Pushed from the host to the webview while a dbt run/build/test is in
 * flight. `status` events arrive as dbt's own `--log-format json` stream is
 * parsed (see packages/vscode/src/host/run.ts); `log` events carry that
 * same stream's human-readable text, attributed to whichever node dbt
 * itself attributed the line to (a line with no node attribution produces
 * neither a `status` nor a `log` event); exactly one `done` event arrives
 * when the underlying process exits. */
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "log"; nodeId: string; line: string }
  | { type: "done"; exitCode: number };
