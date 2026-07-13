# Static DAG CLI — Design

**Status:** approved (design), pending implementation plan
**Date:** 2026-07-13
**Package:** new `@dbt-open-lineage/cli` (new workspace member, depends on `@dbt-open-lineage/core`)

## Purpose

`dbt docs generate` ships a static `index.html` for browsing lineage, rendered with a D3-manipulated
SVG DOM and a force-directed layout that re-simulates on load and on interaction. This repo's existing
DAG viewer (VSCode extension / Mnemo `.mext`) is faster because it (a) renders with React Flow —
virtualized, only touches nodes in viewport — and (b) starts blank and only lays out a dbt-selector-scoped
subgraph via a single deterministic dagre pass, never the whole project graph at once.

Goal: package that same fast viewer as a standalone static site generator, so it can run in CI
(GitHub Actions), read a project's `manifest.json`, and produce a static `index.html` + assets deployable
to any static host (GitHub Pages, S3, etc.) — without requiring a VSCode/Mnemo host.

## Non-goals

- **No editing.** Annotation authoring (callouts, subject-area/label editing, drawing, gist save) all
  assume a live host that can write files back to the project. The static output has no backend, so none
  of that ships here. Existing subject areas/labels/gists **already committed** to the project's
  `lineage.yml` sidecar still **render** (read-only) — only the editing UI is dropped.
- **No live-reload server.** Output is a one-shot generated artifact, same model as `dbt docs generate`.
  Re-running the CLI regenerates it; there's no watch mode.
- **No npm publish work in this pass.** This design covers building the package correctly so it *can* be
  published (`npm publish` from `packages/cli`) and consumed via `npx @dbt-open-lineage/cli`, but actually
  publishing/versioning it is a follow-up, not part of this implementation.

## Architecture

New workspace package `packages/cli`, sibling to `core`, `vscode`, `mext`. Depends on
`@dbt-open-lineage/core` via the npm workspace link.

**Refactor:** `parseManifest()` currently lives in `packages/vscode/src/host/manifest.ts`. Its logic has
no VSCode dependency — only its location is host-specific. Move it to `packages/core/src/manifest.ts` so
`vscode` and `cli` share one implementation; `vscode`'s host file becomes a thin re-export to avoid
touching its existing call sites.

**Read-only mode:** add a `readOnly?: boolean` prop to `App.tsx` (default `false` — extension/mext
behavior unchanged). When `true`, hides the annotation toolbar, callout/drawing editing controls, and
gist-save button. Subject-area/label/tag *display* (read from the `lineage.yml` sidecar) is unaffected —
only editing affordances are hidden. Chosen over forking a parallel component tree to keep one shared
codebase instead of two diverging UIs; the prop is additive and conditional, not a structural change.

**Static bridge:** new `StaticBridge` implementing the existing `Bridge` interface
(`packages/core/src/bridge.ts`), backed by data embedded at build time instead of a live host:
- The manifest-parse `invoke()` call resolves immediately with the pre-parsed `Graph`.
- `fs.readText` for the sidecar path resolves with the embedded `lineage.yml` content.
- Write calls (`fs.writeText`, `dbt.gist`) reject — unreachable in practice since their UI is hidden in
  read-only mode, but implemented as a safety net rather than silently no-oping.

**Build/publish pipeline:** the JS/CSS bundle (React + React Flow + `core` + `StaticBridge`) is built
**once at package-build/publish time** via the same esbuild/vite pipeline `vscode`/`mext` already use,
checked into `packages/cli/dist` — not rebuilt on every CLI invocation. This mirrors `panel.ts`'s
`buildHtml()` pattern: the CLI's job at runtime is templating + data injection, not bundling.

## CLI interface

```
npx @dbt-open-lineage/cli generate \
  --manifest ./target/manifest.json \
  --out ./public \
  [--sidecar ./lineage.yml] \
  [--title "My Project"]
```

Runtime steps: parse manifest → parse optional sidecar → inject both as JSON into a `<script>` tag in a
template `index.html` → write `index.html` next to the prebuilt `assets/*.js` and `assets/*.css` into
`--out`. Result is a small multi-file static site, not a single monolithic HTML file — only the **graph
data** is inlined (per design decision), not the JS/CSS bundle itself.

## Data flow

```
manifest.json ──┐
                ├─→ parseManifest() (core) ──┐
lineage.yml ────┘   (optional, read-only)    ├─→ JSON embedded in index.html <script>
                                              │
prebuilt assets/*.js, assets/*.css ───────────┴─→ copied into --out alongside index.html
```

At page load: `main.tsx`-equivalent entry reads the embedded JSON (analogous to `window.__DOL_INIT__` in
the VSCode webview), constructs a `StaticBridge` around it, calls `setBridge()`, mounts `<App readOnly />`.

## Error handling

- Missing/unreadable `--manifest` → CLI error, exit 1, message includes the path.
- Malformed manifest JSON → existing `parseManifest` error, wrapped with the file path.
- Missing `--out` directory → created automatically (`mkdir -p` semantics).
- Missing `--sidecar` → not an error; treated as "no annotations" (sidecar is optional).

## Testing

- Reuses `core`'s existing test suite unchanged.
- New: `StaticBridge` unit tests (canned data resolves correctly; write calls reject).
- New: `App.test.tsx` case asserting `readOnly` hides edit controls.
- New: CLI smoke test — tiny fixture `manifest.json` → run `generate` → assert `index.html` contains the
  expected embedded data marker and correctly references the JS/CSS assets on disk.

## GitHub Actions usage (reference, not part of this package's implementation)

```yaml
- run: dbt compile   # produces target/manifest.json
- run: npx @dbt-open-lineage/cli generate --manifest ./target/manifest.json --out ./public
- uses: actions/deploy-pages@v4   # or any static-host deploy step
  with: { path: ./public }
```
