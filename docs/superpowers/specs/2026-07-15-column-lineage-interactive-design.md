# Column-level lineage (interactive extension) — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Column-level lineage as a toggle in the live, interactive DAG — both the
VSCode extension (`packages/vscode`) and the Mnemo `.mext`
(`packages/mext`), shipped together per this repo's parity rule. Companion
to `2026-07-15-column-lineage-design.md` (the static CLI's version, already
built and shipped); this spec reuses that one's data model and dbt-colibri
integration details rather than re-deriving them.

## Why Python is acceptable here after all

The static-CLI spec ruled out a per-user Python dependency for this exact
surface. That decision is explicitly revisited and reversed here: the user
confirmed a `pip install dbt-colibri` cost on each end-user's machine is
acceptable for the interactive extension too, given dbt-colibri's proven
accuracy (already integrated and working in the CLI) versus the
never-fully-verified TS-native alternatives evaluated in the CLI spec's
appendix (Polyglot pre-1.0, single-maintainer; a from-scratch
`node-sql-parser` heuristic). Same orchestration approach as the CLI:
spawn `colibri`, parse `colibri-manifest.json`, trim via
`extractColumnLineage()` (already built in `packages/core/src/columnLineage.ts`).

## Repo-boundary note (read before implementation planning)

`packages/mext` in *this* repo is only the sandboxed iframe's JS bundle
plus `manifest.json`'s `host_perms` list — every `host_perms` command
(`dbt.manifest`, `dbt.compile`, `dbt.gist`, etc.) is actually implemented in
**Mnemo's own repo** (separate Rust/Tauri codebase), reached via
`postMessage` (`packages/mext/src/bridge.ts`). A new `dbt.columnLineage`
command therefore needs:

- **This repo:** add `"dbt.columnLineage"` to `packages/mext/manifest.json`'s
  `host_perms`; build the shared runner package (§1); wire the VSCode
  extension host (§2); build the toggle UI in `core` (§3) — all fully
  implementable and testable here.
- **Mnemo repo (out of this repo's plan):** implement the actual command
  handler that spawns `colibri` in Rust/Tauri. Per this repo's existing
  `Mnemo changes via subagent` convention, that's a separate subagent
  dispatch to the Mnemo repo once this repo's side is done — not part of
  the implementation plan that follows from this spec.

## 1. New shared package: `packages/colibri-runner`

Node-only workspace package, sibling to `core`, no browser/webview code.
Moves `runColibri()`'s exact logic out of `packages/cli/src/colibri.ts`
(spawn `colibri generate --manifest <path> --catalog <path> --output-dir
<dir> --light --disable-telemetry`, handle not-found/non-zero-exit/missing-
output errors, call `extractColumnLineage()` from
`@dbt-open-lineage/core/src/columnLineage`) into this package. `packages/cli`
becomes a consumer instead of the owner — its `generate.ts` imports
`runColibri` from `@dbt-open-lineage/colibri-runner` instead of `./colibri`.
`packages/vscode`'s extension host (a real Node process) imports the same
package directly. One implementation, no duplication between the two
Node-hosted consumers.

## 2. VSCode host

New case in `packages/vscode/src/extension.ts`'s `handleMessage` switch,
mirroring the existing `dbt.gist` shape:

```ts
case "dbt.columnLineage": {
  projectRoot = resolveRoot();
  if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
  const manifestPath = path.join(projectRoot, "target", "manifest.json");
  const catalogPath = path.join(projectRoot, "target", "catalog.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} — run \`dbt compile\``);
  if (!fs.existsSync(catalogPath)) throw new Error(`no catalog at ${catalogPath} — run \`dbt docs generate\``);
  const payload = runColibri({ manifestPath, catalogPath });
  reply({ ok: true, result: payload });
  break;
}
```

`runColibri`'s own "colibri not found" / non-zero-exit errors propagate
through the existing `catch (e) { reply({ ok: false, error: ... }) }`
wrapper already in `handleMessage` — no new error-handling machinery
needed at this layer, same as every other command.

## 3. Core UI

Reuses the toggle/rendering shape already built for the static CLI's
read-only mode (`2026-07-15-column-lineage-design.md` §2/§3), made
interactive:

- New `columnLineage: ColumnLineagePayload | null` state in `App.tsx`,
  plus a toggle button in the toolbar (same pill-button pattern as
  Focus/regex-mode).
- **On toggle click** (lazy — matches the "on toggle click" decision, not
  auto-run on every compile): if `columnLineage` state is `null`, call
  `invoke<ColumnLineagePayload>("dbt.columnLineage", {})`, show a loading
  state on the toggle button while the promise is in flight (colibri is a
  real subprocess, not instant).
- **Cache invalidation:** the fetched payload stays in state until the next
  successful `dbt.compile` (which already replaces `graph` state) — that
  state transition also clears `columnLineage` back to `null`, so the next
  toggle-on re-fetches against the fresh manifest instead of serving stale
  column data.
- **Rendering:** same column-card/column-edge visualization as the CLI
  spec's §2 (columns listed on node cards, real column-to-column edges from
  `payload.edges`, `hasLineage: false` columns shown present-but-unconnected)
  — but interactive here: no `readOnly` restriction, so this toggle behaves
  like every other live toolbar control.

## 4. Error handling

Two failure modes an end user hits directly (not a CI log, so both need a
clear, actionable inline message — reusing the existing inline-error banner
pattern already used for run/export errors):

- **`colibri` not on PATH:** the shared package's existing message
  (`"dbt-colibri (colibri) not found. Install with: pip install
  dbt-colibri"`) surfaces verbatim in the toggle's error banner.
- **`catalog.json` missing:** dbt-colibri needs both manifest and catalog;
  unlike `dbt compile` (already a one-click action in this extension),
  `dbt docs generate` isn't currently triggered by anything in this
  extension. Error message names the exact command to run:
  `"no catalog at <path> — run \`dbt docs generate\`"` (per §2's exact
  string). Out of scope for this spec: wiring a one-click "generate docs"
  action — that's a possible follow-up, not required to ship the toggle.

## 5. Testing

- `packages/colibri-runner`: `colibri.test.ts` moved verbatim from
  `packages/cli` (same mocked-`spawnSync` tests, same
  `// @vitest-environment node` fix already known from the CLI's build).
- `packages/vscode/src/extension.test.ts` (or wherever `handleMessage` is
  tested — follow existing `compile.test.ts`/`gist.test.ts` pattern): new
  case with a mocked `runColibri`, asserting the reply shape on success and
  both error messages (colibri not found is simulated via the mock
  rejecting, matching what `runColibri` itself already throws — this test
  does not need `catalog.json`'s missing-file check re-tested at the
  package level since that's `colibri-runner`'s own responsibility;
  `extension.ts`'s test covers only ITS OWN pre-flight
  manifest/catalog-existence checks and the reply-wrapping).
- `packages/core/src/App.test.tsx`: render test for toggle-click → loading
  → rendered payload (columns/edges appear); toggle-click → error banner
  when the mocked `invoke("dbt.columnLineage", ...)` rejects; a second
  `dbt.compile` after column lineage is loaded clears it back to
  toggle-off-equivalent state (cache invalidation).

## Out of scope

- Mnemo repo's actual `dbt.columnLineage` Rust/Tauri handler — separate
  subagent dispatch, not part of the implementation plan from this spec
  (see "Repo-boundary note" above).
- A one-click "generate docs" action to produce `catalog.json` — the error
  message tells the user the command to run manually; wiring it as a button
  is a possible follow-up, not required here.
- Schema-aware `SELECT *` resolution or any SQL-parsing logic of our own —
  dbt-colibri owns 100% of the lineage inference in this design; there is no
  TS-native fallback path in this spec (unlike the CLI spec's now-moot
  appendix, since Python was accepted here).

## Open risks

- **Accuracy on real Redshift SQL** — same caveat as the CLI spec, not
  re-litigated here; already accepted at that decision point.
- **End-user friction of `pip install dbt-colibri` + running `dbt docs
  generate` manually** — this is the actual cost of the "Python is fine
  here too" decision. Not a technical risk, a UX one: first-run experience
  for a user who has neither installed is two clear error messages in
  sequence (colibri missing, then catalog missing) rather than one combined
  onboarding flow. Acceptable per the scope decision above, but worth
  knowing going in.
