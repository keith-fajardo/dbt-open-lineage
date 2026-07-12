# DAG Annotations — Design

**Status:** approved (design), pending implementation plan
**Date:** 2026-07-12
**Package:** `@dbt-open-lineage/core` (rendered by both the VSCode extension and the Mnemo `.mext` consumer)
**Mockup:** interactive reference built during brainstorming (callouts, multi-area zones, spotlight/dim, favorites, colored labels)

## Purpose

Use the lineage graph as a **documentation tool** — a way to explain a dbt project to another
developer directly on the DAG, plus a personal layer for filtering to the models you care about.

Today the viewer already stores a per-model **gist** (a short note in `meta.gist`, AI-assisted via the
sparkle button, saved to the schema `.yml`). This feature builds four annotation layers on top of the
existing React Flow canvas, reusing that gist as the model's note.

## The layers

Two are **shared** (committed to yaml, git-diffable, travel with the repo). The rest are **personal** and
never committed — favorites persist in `localStorage`; freehand drawing is **ephemeral, in-memory only**.

| Layer | Store | Shared | Cardinality | Renders as |
|---|---|---|---|---|
| **Callout** | `meta.gist` + `meta.callout` | yes | one note / model | text bubble + leader line into the node |
| **Subject area** | `meta.subject_areas` (list) + sidecar style | yes | many / model | bounded zone (box or hull) around members |
| **Label** | `meta.labels` (list) + sidecar style | yes | many / model | colored stripe on the node + filter chip |
| **Favorite** | `localStorage` | no | boolean / model | ★ on the node + filter chip |
| **Drawing** | in-memory (session only) | no | — | freehand ink over the canvas |

### Design rules that fall out of the graph being dynamic

The DAG re-runs layout (dagre) + `fitView` whenever the visible set changes (dbt selector `+model+`,
spotlight, focus). Therefore:

- **Anchor to nodes, never to canvas coordinates.** Callouts anchor to their node; zones are recomputed
  from member node positions every render. Both survive relayout. Anything pinned to an absolute `(x,y)`
  orphans on the next layout — which is why **free-floating region notes are cut** (see Non-goals).
- **Freehand drawing is the one deliberate coordinate-space exception**, and it earns it by being
  ephemeral: ink lives in flow-space so it pans/zooms *with* the graph and stays over the models you drew
  on, and it is **cleared automatically on relayout** (a filter/selector change moves the nodes) so it can
  never strand. It is in-memory only — never persisted, never committed.
- **Spotlighting an area dims, it does not relayout.** Selecting a subject area lights its members and
  dims everyone else to ~15% opacity — the same interaction as clicking a node to highlight its lineage.
  No repack. This composes cleanly with multi-area membership: a model shared across two areas stays lit
  under either spotlight.

## Data model

### Committed — per-model `meta` (schema `.yml`)

```yaml
models:
  - name: int_order_item_ledger__enriched
    meta:
      subject_areas: [order_ledger, discounts]   # many → overlapping/nested zones are fine
      gist: "Enriches & confirms the ledger against certificate_ledger."
      callout: top                               # placement; omit ⇒ callout hidden
      labels: [core, revenue]                    # many → node stripes + filter chips
```

- `gist` already exists and is written via the current save path
  (`fs.readText` → `upsertModelDoc` in `src/yamlEdit.ts` → `fs.writeText`). The **callout renders the
  gist** — there is no separate callout-text field in v1.
- `callout` is a placement enum (`top` for v1; `bottom`/`left`/`right` reserved). Absent ⇒ not shown.
- `subject_areas` and `labels` are string lists. Membership is derived by "models whose list contains
  this key." A model may belong to several areas.

### Committed — sidecar registry `lineage.yml` (project root)

Holds display style for areas and labels (label text + color). One file, git-diffable.

```yaml
# Block or flow mapping both parse identically; block shown here.
areas:
  order_ledger:
    name: "Order Ledger"
    color: "#8b5cf6"
  web_session:
    name: "Web Session"
    color: "#14b8a6"
labels:
  core:
    name: "Core"
    color: "#ef4444"
  revenue:
    name: "Revenue"
    color: "#22c55e"
```

Core reads this file through the bridge (`fs.readText`) and parses it with the existing `yaml`
dependency. Editing a color (color picker in the filter bar) writes the file back via `fs.writeText`.

### Personal — `localStorage`

```
key:   dol.personal.<projectPath>
value: { "favorites": ["<uniqueId>", ...] }
```

Webview-local (works identically in the VSCode webview and the Mnemo iframe), survives reload, never
committed, never git-diffed. Project scope comes from the `onContext` project path. Favorites are
**filter-only** — they never draw zones.

## Three committed marker concepts — keep them distinct in the UI

There are now three string-marker-like concepts. They must read as clearly different because they behave
differently:

| Concept | Source field | Purpose | UI |
|---|---|---|---|
| **dbt tag** | `config.tags` (manifest) | dbt run-selection | filter chip, **read-only** |
| **subject area** | `meta.subject_areas` | grouping | **zone** + spotlight |
| **label** | `meta.labels` | importance / semantics (Core, PII, …) | node **stripe** + filter chip |

The viewer never writes to `config.tags`. dbt tags already arrive on `GraphNode.tags` and are surfaced
as read-only filter chips (free reuse of existing data).

## Rendering

### Callout
A bubble containing the node's gist, positioned per `callout` placement, with a colored leader line to
the node's current position. Redrawn each render so it tracks the node through relayout. When the node is
dimmed by a filter/spotlight, the callout dims with it.

### Subject-area zone
Computed from the current positions of the area's member nodes:
- **Box** (v1 default): padded bounding rectangle, rounded, dashed stroke in the area color, translucent fill.
- **Hull** (option): convex hull of member rectangle corners, padded outward. Hugs the members so it
  swallows fewer unrelated nodes that happen to sit inside a bounding box. Chosen via a Box/Hull toggle.
- A title tab (area label + member count) sits at the zone's top-left.
- Overlapping / nested zones are expected (multi-area membership) and render as stacked translucent fills.

### Freehand drawing (whiteboard pen)
A live-explanation ink layer for talking over the graph on a screenshare. In-memory only.

- **Draw mode toggle** (pen). While on, pan and node-drag are suppressed so pointer strokes are captured;
  turning it off restores normal graph interaction.
- **Flow-space strokes.** Screen pointer positions are converted to flow coordinates
  (React Flow `screenToFlowPosition`) and stored as polylines in flow-space, so ink pans/zooms with the
  graph and stays over the models. Rendered in a layer that carries the viewport transform.
- **Visible on the dark canvas.** Default stroke is a bright near-white with a subtle glow; a small palette
  (e.g. white / cyan / magenta) and one or two stroke widths. No dark default that would vanish.
- **Erase + clear.** An **eraser** removes an individual stroke (pointer over a stroke deletes that
  polyline); **Clear all** wipes every stroke. Ink also auto-clears on relayout (see design rules) and is
  gone on reload — it is never saved.

### Filter bar
A single bar of chips. Clicking a chip narrows the graph; a node matches when it satisfies **all** active
filters (AND):
- **Favorites** ★ (one toggle)
- **Labels** (one chip per label; each chip carries a swatch → color picker that writes the sidecar)
- **dbt tags** (read-only chips)
- **Subject-area spotlight** (choosing an area dims non-members; only the active zone is drawn)

Non-matching nodes/edges/callouts drop to ~15% opacity. No relayout.

## Architecture fit

- **Host-agnostic core.** All host access goes through the existing `Bridge`
  (`invoke`, `saveExport`, `openInIde`, `onContext`) in `src/bridge.ts`. No new host-specific code in core.
- **Reads:** model `meta` already flows through the manifest→`Graph` pipeline onto `GraphNode.meta`
  (that is how `meta.gist` reaches the panel today), so `subject_areas`, `callout`, and `labels` come for
  free. The sidecar is read via `invoke('fs.readText', { path })`.
- **Writes:** membership/labels → schema `.yml` `meta` via the existing yaml-edit path (extended to
  upsert list-valued meta keys — see `src/yamlEdit.ts`, and honor the `lineWidth: 0` gotcha so untouched
  column descriptions don't re-wrap). Sidecar style → `fs.writeText`. Favorites → `localStorage`.
- Both consumers (VSCode extension, Mnemo `.mext`) render the same core UI unchanged; any change is
  mirrored to the sibling VSCode repo per the existing mirror rule.

## Scope

### In scope (Phase 1)
- Read + render all four layers; membership/notes/labels **authored by hand in yaml** (headless-friendly).
- Box/Hull zones; spotlight-dim; the unified filter bar; favorites via `localStorage`.
- Editing **label and area colors** from the filter bar (writes the sidecar) — the requested "custom color".
- **Freehand drawing** overlay (pen with a bright stroke, palette, eraser + Clear all, in-memory only).

### Non-goals / deferred (Phase 2, noted so we don't design them out)
- **Canvas authoring** — lasso nodes → "group into subject area", assign labels, add a callout, all via a
  right-click menu that writes the same yaml back. Phase 1 is yaml-authored.
- **Manual callout text** override (canvas text ≠ gist). v1 callout is always the gist.
- **Compound "auto-nudge" layout** (physically packing area members into a tidy box while the rest of the
  graph stays visible). Spotlight-dim covers the explaining use case without it.
- **Free-floating region notes** — cut. They pin to `(x,y)` and orphan on relayout. Area-level prose, if
  ever needed, attaches to the subject area (`area.description`), which is node-derived and survives.

## Testing

`@dbt-open-lineage/core` uses vitest. Cover:
- **yamlEdit**: upsert of list-valued `meta` keys (`subject_areas`, `labels`) without disturbing existing
  keys or re-wrapping column descriptions (`lineWidth: 0`).
- **Geometry**: convex-hull + padding produces a polygon that contains all member corners and excludes a
  planted stranger point.
- **Filter logic**: `matchNode` AND-composition across favorites, labels, and area spotlight.
- **Favorites store**: `localStorage` read/write keyed by project path; round-trips and stays empty for a
  fresh project.
- **Sidecar**: parse of `lineage.yml`; color write round-trips.
- **Drawing**: screen↔flow coordinate round-trip; eraser removes only the hit stroke; Clear-all empties the
  set; a simulated relayout clears the ink.

## Open question for the plan

Membership on read is trivial (list contains key). The one implementation nuance to settle in the plan is
the **list-valued meta upsert** in `yamlEdit.ts` — appending/removing a value from `meta.subject_areas` /
`meta.labels` while preserving formatting and the `lineWidth: 0` behavior. Everything else is composition
of existing pieces.
