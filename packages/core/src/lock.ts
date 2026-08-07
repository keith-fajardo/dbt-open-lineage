/** Pure lock predicates for the lineage view (unit-tested in isolation so the
 * App.tsx wiring stays thin). */

/** Effective lock state: a run auto-locks the lineage; the manual toggle locks
 * it even when idle. `runActive` is App's run state (a command string while a
 * run is in flight, else null). */
export function isLineageLocked(locked: boolean, runActive: unknown): boolean {
  return locked || runActive !== null;
}

/** Whether a deliberate lineage switch should ask first: only when the view is
 * locked AND there are live run statuses that the switch would discard. */
export function shouldConfirmSwitch(lineageLocked: boolean, hasLiveRun: boolean): boolean {
  return lineageLocked && hasLiveRun;
}
