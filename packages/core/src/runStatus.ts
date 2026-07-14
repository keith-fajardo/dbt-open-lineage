/** Per-node run outcome. Absence of an id from a status map means "idle" —
 * "idle" is deliberately not a member of this type, so a caller can't
 * accidentally treat "no entry yet" and "explicitly idle" as different
 * states. */
export type Status = "running" | "success" | "failed" | "skipped";

/** Pushed from the host to the webview while a dbt run/build/test is in
 * flight. `status` events arrive as dbt's own `--log-format json` stream is
 * parsed (see packages/vscode/src/host/run.ts); exactly one `done` event
 * arrives when the underlying process exits. */
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "done"; exitCode: number };
