# Regex selector mode — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

A new toggle beside the selector box: when on, the box's typed text is
interpreted as a case-insensitive regex matched against model names,
instead of dbt selector syntax. A pure mode switch — dbt selector syntax
(`+` hops, `tag:`, `--exclude`, etc.) does not apply while regex mode is
on, and vice versa.

Independent from the `2026-07-15-emphasized-run-scope` spec/plan (different
subsystem — selector-box matching, not run-scope/filter intersection).
That plan is unaffected and unchanged by this one.

## 1. The toggle

New `regexMode: boolean` state (default `false`). Rendered as a pill-button
immediately after the selector `<input>`, before the Focus button — same
visual style as Focus/Favorites (`aria-pressed`, border/background keyed
off state). Labeled **".*"**, with a `title` tooltip explaining it (e.g.
"Regex mode: match model names by pattern instead of dbt selector syntax").

## 2. Matching logic

`matched`'s computation forks on `regexMode`:

- **`regexMode === false`** (default): unchanged — `resolveSelector(graph,
  cleanedSelector)`, today's dbt selector syntax path.
- **`regexMode === true`**: compile `new RegExp(cleanedSelector, "i")`
  (case-insensitive) in a try/catch.
  - Success → `matched` = the ids of every node whose `name` matches the
    pattern (`RegExp.test(node.name)`).
  - Failure (invalid pattern, e.g. an unbalanced paren mid-typing) →
    `matched` = empty set, and a new `regexError: string | null` state
    holds a short message (e.g. `"invalid pattern"`) for inline display.

`--full-refresh` token detection/stripping (`hasFullRefreshFlag`/
`stripFullRefreshFlag`) still runs on the raw committed `selector` text
BEFORE either matching path — mode-independent. `int_ --full-refresh`
strips to `int_` for regex matching, exactly as it strips to `int_` for
selector resolution today.

The existing blank-box behavior (empty text → blank DAG, Show-All-confirm
available on Enter) is unchanged and mode-independent: an empty pattern in
regex mode is still "blank," gated by the same `cleanedSelector.trim()`
check already used everywhere else.

`focalName` (the mechanism that highlights "this is the currently open
model" when the IDE pushes a context) remains selector-mode-only — regex
mode never claims a focal model from typed text, matching how any other
multi-match dbt selector already behaves today (empty string returned,
no highlight).

## 3. Error display

A small red inline message near the selector input, shown only when
`regexMode && regexError` is truthy — same visual treatment as the
existing `runErr`/`exportErr` inline banners elsewhere in the toolbar.
Clears automatically the moment the pattern becomes valid again (i.e.
`regexError` is recomputed alongside `matched` on every `cleanedSelector`/
`regexMode` change, not a separate manual-clear action).

## 4. Mode-switch lifecycle

Toggling `regexMode` — even without changing the typed text — immediately
reclassifies what `matched` contains (dbt-selector interpretation vs. regex
interpretation of the same string are generally unrelated sets). To avoid
stale pilot-light/run-status/pruning state lingering across a mode switch,
`regexMode` is added to the same reset effect that already clears run
status/logs (from the run-button feature) and pruning (from the
`emphasized-run-scope` plan, once implemented) on selector/lineage change.

## Testing

- Regex mode OFF (default): dbt selector syntax behaves exactly as before
  — a regression check, not new behavior.
- Regex mode ON: a pattern like `int_` matches every node whose name
  contains it, case-insensitively (`INT_` typed also matches `int_orders`).
- Anchors/alternation work: `^stg_`, `_test$`, `orders|payments` all
  resolve to the expected node sets against a small fixture graph.
- An invalid pattern (e.g. `int_(`) produces an empty `matched` set AND a
  visible inline error; a subsequent edit that fixes the pattern clears the
  error and repopulates `matched`.
- `--full-refresh` still strips correctly in regex mode (a run triggered
  with `int_ --full-refresh` typed while regex mode is on sends
  `hasFullRefresh: true` and matches only nodes containing `int_`).
- Toggling regex mode on/off with an active run status present clears that
  status (same lifecycle point already covered by the existing
  selector-change reset tests).
- An empty box in regex mode behaves identically to an empty box in
  selector mode (blank DAG, Show-All-confirm available on Enter).

## Out of scope

- Combining regex with dbt selector syntax in the same query (explicitly
  rejected — pure mode switch only, confirmed in brainstorming).
- Regex flags beyond case-insensitivity (e.g. multiline, sticky) — not
  requested.
- Persisting the toggle's on/off state across sessions/reloads — defaults
  to off every time, same as every other toolbar toggle in this codebase.
