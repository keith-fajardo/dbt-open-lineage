/** dbt selectors are whitespace-delimited tokens (e.g. `tag:mart --exclude
 * config.materialized:view`). A handful of dbt RUN flags aren't real selector
 * syntax but users type them into the same box — `--full-refresh`, `--defer`,
 * and `--state <dir>`. They must be pulled OUT of the text before it reaches
 * resolveSelector (an unrecognized term silently matches nothing, and in regex
 * mode a stray `--state` would corrupt the pattern) and instead ride to the
 * host as their own run args. `parseRunFlags` does that extraction in one pass,
 * returning the cleaned selector plus the flags it found. */

const FULL_REFRESH = "--full-refresh";
const DEFER = "--defer";
const STATE = "--state";

export interface RunFlags {
  /** Selector text with every recognized run flag removed (whitespace
   * normalized to single spaces — resolveSelector splits on `\s+` anyway). */
  selector: string;
  fullRefresh: boolean;
  defer: boolean;
  /** The `--state <dir>` (or `--state=<dir>`) artifacts path; undefined when
   * the flag is absent or given with no path. Last occurrence wins. */
  state?: string;
}

export function parseRunFlags(text: string): RunFlags {
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let fullRefresh = false;
  let defer = false;
  let state: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === FULL_REFRESH) { fullRefresh = true; continue; }
    if (t === DEFER) { defer = true; continue; }
    if (t === STATE) {
      // Value flag: the NEXT token is the artifacts dir. Consume it too. A
      // trailing bare `--state` (no following token) is simply dropped.
      const next = tokens[i + 1];
      if (next !== undefined) { state = next; i++; }
      continue;
    }
    if (t.startsWith(STATE + "=")) {
      // `--state=<dir>` equals form; an empty value keeps any prior state.
      const v = t.slice(STATE.length + 1);
      if (v) state = v;
      continue;
    }
    kept.push(t);
  }
  return { selector: kept.join(" "), fullRefresh, defer, state };
}
