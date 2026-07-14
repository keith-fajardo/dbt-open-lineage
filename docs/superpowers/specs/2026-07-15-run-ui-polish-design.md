# Run UI polish: dropdown close, marble color, per-model logs — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Three small, related fixes to the DAG viewer's Run/Build/Test feature:

1. The Run▾ dropdown menu doesn't close on an outside click.
2. The "skipped" pilot-light marble is too close in hue to "running" (both
   orange-family), hard to tell apart at a glance.
3. The details sidebar gets a new section showing each model's own dbt log
   lines from its most recent run.

Bundled as one spec since all three touch the same feature area and are
individually small, but each gets its own implementation task.

## 1. Run-dropdown click-outside-to-close

`packages/core/src/App.tsx`'s Run▾ dropdown (`runMenu` state, `App.tsx`
around line 728/1049) currently only closes when a menu item is clicked —
there's no outside-click handling, so it stays open if the user clicks
anywhere else in the DAG.

Fix: attach a `document` `mousedown` listener via `useEffect`, active only
while `runMenu` is true, that closes the menu when the click target is
outside the dropdown's DOM subtree (tracked via a `ref` on the dropdown's
wrapper `<div>`). Listener removed when the menu closes or the component
unmounts — standard React outside-click pattern, no new dependency.

## 2. Skipped marble color

`packages/core/src/nodes.tsx`'s `RUN_STATUS_RGB` currently has:
- `running`: `249, 115, 22` (`#f97316`, orange) — blinks
- `skipped`: `245, 158, 11` (`#f59e0b`, amber) — static

Both are orange-family and read as nearly the same color, especially since
running's blink draws the eye and skipped's static amber can look like a
paused version of the same hue. Change `skipped` to `250, 204, 21`
(`#facc15`, Tailwind yellow-400) — clearly yellow, not orange, and doesn't
collide with any other state (success=neon green, failed=deep red,
queued=sky blue, running=orange).

## 3. Per-model run logs in the sidebar

### Problem

Right now dbt's human-readable log output only reaches the VSCode Output
panel (host-side); the webview only receives per-node `status` events
(`RunEvent`'s `status`/`done` variants). There is no way to see *why* a
specific model failed, or what it actually did, from inside the DAG view
itself.

### Scope of "logs for this model"

Only lines dbt itself attributes to a node — i.e. lines whose parsed JSON
carries `node_info.unique_id` (or, for a test line, `data.attached_node`,
same resolution `parseDbtLogLine` already does for status routing). Global
banner/summary/formatting lines (no node attribution) are not shown
per-model — they're not this feature's concern, and remain visible only in
the Output panel, as today.

### Host: `packages/vscode/src/host/run.ts`

`parseDbtLogLine` currently returns at most one `RunEvent` per line (a
`status` event, when the line's `node_status` maps to a known `Status`) —
lines that carry a node id but no recognized status are otherwise
discarded event-wise (still displayed in the Output panel, but with no
webview-visible trace). Change `parseDbtLogLine` to return zero, one, *or
two* events per line: a `log` event whenever the line carries a resolvable
node id (regardless of whether `node_status` maps to anything), in
addition to the existing `status` event when one also applies. `startDbtRun`
forwards every returned event to `cb.onEvent` exactly as it does today —
no change needed there, since it already loops over "the event(s) this line
produced," it just currently assumes at most one.

### New `RunEvent` variant (`packages/core/src/runStatus.ts`)

```ts
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "log"; nodeId: string; line: string }
  | { type: "done"; exitCode: number };
```

### Webview state (`packages/core/src/App.tsx`)

New state, sibling to `runStatus`:

```ts
const [runLogs, setRunLogs] = useState<Map<string, string[]> | null>(null);
```

`onRunEvent`'s handler gains a `log` branch: appends `line` to
`runLogs.get(nodeId)` (creating the array if absent), same
copy-on-write-Map pattern `runStatus`'s `status` branch already uses.

**Lifecycle** (mirrors `runStatus` exactly — same three reset points, plus
one no-op point worth calling out):
- **New run** (`onRun`): `runLogs` reset to a fresh empty `Map`, at the same
  point `runStatus` is seeded with `queued` — a second Run without an
  intervening Refresh/lineage-change *replaces* per-model logs, it does not
  append across runs.
- **Refresh button** (`onResetStatus`): `runLogs` cleared to `null`,
  alongside `runStatus`.
- **Lineage change** (the `useEffect` keyed on `selector`): `runLogs`
  cleared to `null`, alongside `runStatus`.
- **Run ends** (`done` event): no change to `runLogs` — logs are left as
  accumulated; only `runStatus`'s "never left spinning" reconciliation
  applies at `done`, logs have no equivalent terminal-state concept.

### Sidebar UI (`App.tsx`'s details `<aside>`)

New section below the existing `tests` section, shown for the currently
`selectedNode` regardless of `readOnly`/`editable` (logs are informational,
not an edit affordance — same visibility rule as `tests`, `materialization`,
`path`). Rendered **only when `runLogs?.get(selectedNode.id)` is non-empty**
— an idle/never-run node shows no logs section at all, keeping the panel
uncluttered for the common case.

- Fixed height (~150px), `overflow-y: auto`, monospace font, small text
  size (matches the panel's existing `dl`/`dd` sizing conventions).
- One line per log entry, in arrival order.
- Auto-scrolled to the bottom when a new line arrives while this node's
  panel is open (so a live-running model's log reads like a tailing
  terminal) — implemented via a `ref` + `scrollTop = scrollHeight` in a
  `useEffect` keyed on the log array's length, guarded to only fire when
  the box is actually mounted (i.e. `selectedNode` is this node).

## Testing

- Dropdown: a test that opens the menu, clicks outside (e.g. the pane
  background), and asserts the menu is no longer in the document; a
  companion test that clicking *inside* the dropdown (e.g. one of its own
  buttons) does not spuriously close it before the click handler runs.
- Marble color: update the existing `skipped` color assertion in
  `nodes.test.tsx` to the new RGB triple.
- `parseDbtLogLine`: new tests asserting a node-attributed non-status line
  (e.g. a line with `node_info` but an unrecognized `node_status`) now
  returns a `log` event; a line that already produces a `status` event
  ALSO produces a `log` event for the same line (both present, not
  either/or); a line with no node attribution produces neither.
- `App.tsx`: new tests for the `runLogs` lifecycle — a `log` RunEvent
  appends to the right node's array; a second `onRun` click resets
  `runLogs` to empty before the new run's events arrive; Refresh and a
  lineage change both clear `runLogs` to `null`; the sidebar's logs section
  is absent for a node with no logs and present (with the right lines, in
  order) for one that has them.

## Out of scope

- Persisting logs across a DAG reload / extension restart.
- Log lines for resource types other than what a run/build/test already
  covers (i.e. this doesn't change what dbt logs, only what's captured and
  shown from output that already exists).
- Copy/export/search within the per-model log box.
