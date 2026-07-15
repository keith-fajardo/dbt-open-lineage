# Column-level lineage (static CLI) — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Column-level lineage as an **opt-in** feature of `@dbt-open-lineage/cli`'s
static site generator (`packages/cli`) only. The live VSCode/Mnemo
interactive extension is explicitly out of scope for this pass — see
"Deferred" below.

## Why the static CLI, not the interactive extension

- `packages/cli`'s `generate()` runs in a controlled environment you
  configure (CI or local machine), not distributed to end users the way the
  VSCode extension is. A Python dependency there is a one-time CI-step cost,
  not a per-user install burden.
- Output is static HTML/CSS/JS deployed elsewhere (GitHub Pages, S3, any
  static host). The Python dependency never reaches the serving box — only
  the generation step needs it.
- The package is already read-only (no annotation authoring, per
  `2026-07-13-static-dag-cli-design.md`), so column lineage is purely a
  rendering addition — no new write paths to design around.

## 1. dbt-colibri, orchestrated by the CLI

New opt-in `--column-lineage` flag on `generate`. Base `generate()` behavior
(flag absent) is completely unchanged — zero new dependency unless a user
explicitly opts in.

When the flag is set:

1. Requires `catalog.json` in addition to `manifest.json` (dbt-colibri needs
   both). New `catalogPath` option on `GenerateOptions`
   (`packages/cli/src/generate.ts`).
2. `generate()` spawns the real installed CLI (package `dbt-colibri`,
   binary name **`colibri`**) via Node's `child_process`:
   `colibri generate --manifest <manifestPath> --catalog <catalogPath>
   --output-dir <tempDir> --light --disable-telemetry`. `--light` drops
   `compiledCode` from every node in the output (we don't need raw/compiled
   SQL text — dbt-colibri already resolved lineage — and it meaningfully
   shrinks what gets embedded in the static bundle). `--disable-telemetry`
   avoids a network call during a CI build. Verified against the installed
   `dbt-colibri==0.3.0` source (`dbt_colibri/cli/cli.py`).
3. Not found on PATH (`ENOENT` spawning `colibri`) → throws immediately:
   `"dbt-colibri (colibri) not found. Install with: pip install
   dbt-colibri"`. Fails fast, no silent degrade.
4. Non-zero exit (dbt-colibri exits 1 on missing manifest/catalog or any
   internal error, per its `cli.py`) → throws, wrapping its stderr — same
   error style already used for `"failed to parse ${manifestPath}"` in
   `generate.ts`. Missing `compiled_code` on some models does **not** cause
   a non-zero exit — dbt-colibri logs a warning and continues, treating
   those columns as unresolved (`hasLineage: false`) — so partial coverage
   never blocks the whole build.
5. On success, dbt-colibri writes `<tempDir>/colibri-manifest.json` (and
   `<tempDir>/colibri-parsing-errors.json` if it hit SQL it couldn't parse).
   `generate()` reads `colibri-manifest.json`, extracts the column-edge data
   (see §3 below), and embeds it into the static bundle **at generate
   time** — same "data baked in" pattern `StaticBridge` already uses for the
   graph/sidecar. The deployed site itself never invokes Python; only the CI
   step that ran `generate --column-lineage` did. dbt-colibri's own
   `index.html`/dashboard output is discarded — only its JSON is consumed;
   our React Flow toggle is the UI, not colibri's bundled one.

## 2. Rendering

Toggle switches node cards to show output columns and edges to
column-to-column, reusing the interaction pattern already sketched for the
interactive extension (see appendix) but simplified for read-only mode: no
click-to-author, no annotation UI, same restriction the static CLI already
applies to callouts/labels/drawing. dbt-colibri already classifies resolved
vs. unresolved columns — no need to reinvent that classification here; edges
render only for what it resolved.

## 3. Data model

`colibri-manifest.json`'s real shape (verified against `dbt-colibri==0.3.0`
source, `dbt_colibri/report/generator.py`):

```jsonc
{
  "metadata": { "adapter_type": "redshift", /* ... */ },
  "nodes": {
    "<dbt_node_id>": {
      "id": "...", "name": "...", "nodeType": "model",
      "columns": {
        "<column_name>": {
          "columnName": "...",
          "hasLineage": true,           // false = unresolved, no edges reference it
          "lineageType": "transformation" // "unknown" | "transformation" | passthrough-ish per-source type
        }
      }
    }
  },
  "lineage": {
    "edges": [
      // real column-to-column data edge:
      { "id": 1, "source": "<node_id>", "target": "<node_id>", "sourceColumn": "order_id", "targetColumn": "order_id" },
      // model-level dependency edge (no column resolved), and structural
      // join/filter edges (edgeType set) both use empty string columns —
      // filter these OUT when building the column-lineage view:
      { "id": 2, "source": "<node_id>", "target": "<node_id>", "sourceColumn": "", "targetColumn": "" },
      { "id": 3, "source": "<node_id>", "target": "<node_id>", "sourceColumn": "id", "targetColumn": "", "edgeType": "join" }
    ]
  }
}
```

Only edges where **both** `sourceColumn` and `targetColumn` are non-empty
(no `edgeType`) are real column lineage — these become the toggle's edges.
A column with `hasLineage: false` renders as present-but-unconnected (not a
dashed "unknown" edge — dbt-colibri simply has no edge for it, there's
nothing to render as dashed).

New optional field on the embedded static-bundle payload:
`columnLineage?: { nodes: Record<string, ColibriNodeColumns>; edges:
ColibriColumnEdge[] }` — a filtered/trimmed subset of the above (only the
`columns` map per node and the real column-to-column edges; metadata/tree
are dropped, not needed for rendering). Present only when `--column-lineage`
was used. The column-lineage toggle in `App.tsx` is hidden entirely when
this field is absent — older builds, or builds run without the flag, show no
toggle for data they don't have.

## 4. Testing

- `generate.test.ts`: `--column-lineage` with a stubbed dbt-colibri binary on
  PATH → embedded payload includes `columnLineage`; without the flag →
  payload unchanged (regression).
- Missing dbt-colibri on PATH with flag set → `generate()` throws the
  expected install-instruction message.
- dbt-colibri non-zero exit → `generate()` throws, message includes stderr.
- Static-site render test: toggle appears only when `columnLineage` is
  present in the payload; toggle on/off renders correctly.

## Open risks (resolved / remaining)

- ~~dbt-colibri's actual CLI interface and output JSON schema are
  unverified~~ — **resolved**: verified directly against installed
  `dbt-colibri==0.3.0` source (`dbt_colibri/cli/cli.py`,
  `dbt_colibri/report/generator.py`). Real binary name `colibri`, real flags
  and JSON shape now reflected in §1/§3 above.
- ~~License~~ — **resolved**: MIT (`pip show dbt-colibri` → `License: MIT`).
  Spawning (not bundling) an MIT tool from this OSS npm package is fine.
- **Accuracy on Redshift-dialect SQL**: `redshift` is in dbt-colibri's
  explicit `SUPPORTED_ADAPTERS` list (`extractor.py`) — it detects the
  dialect from `manifest.json`'s `metadata.adapter_type` and raises if
  unsupported, so at minimum it won't silently misparse an unrecognized
  dialect. Actual accuracy on real, messy Redshift SQL is still unverified
  hands-on. Lower stakes than the interactive-extension case would have been
  since this is opt-in/CI-only, not blocking the base tool — bad/missing
  lineage for a given column shows as that column having no edges, not a
  wrong edge (dbt-colibri's own `hasLineage`/`lineageType` fields make
  partial coverage visible rather than silently wrong).

## Deferred: interactive extension

Column lineage inside the live VSCode/Mnemo interactive extension (editable,
real-time, per-end-user) remains deferred. A Python dependency there means
every end user needs `pip install dbt-colibri` locally — a much heavier ask
than a single CI step. If ever revisited, the TS-native engine research below
is preserved for reference.

---

## Appendix: TS-native engine research (interactive extension, deferred)

Evaluated as an alternative to a Python dependency for the *interactive*
extension specifically (not the static CLI, where Python is acceptable per
above).

- **`@polyglot-sql/sdk`** (tobilg/polyglot, MIT, Rust→WASM, 30+ dialects
  including Redshift/Snowflake/BigQuery/Postgres). Ships a purpose-built
  `lineage(column, sql, dialect?)` API with OpenLineage-compatible output.
  Repo created 2026-01-15, 886★, single maintainer, pre-1.0 (v0.6.0).
  Explicitly "inspired by sqlglot" and runs **sqlglot's own 10,220 fixture
  test cases** as its test suite, self-reporting 100% pass rate on
  parsing/dialect/transpilation categories — a real parity signal for the
  underlying parser, though the `lineage()` feature itself is Polyglot's own
  addition on top and isn't covered by that fixture parity claim.
- **`node-sql-parser`-based heuristic** — parser-only (no built-in lineage);
  would require building resolution ourselves (SELECT-list + CTE-chain
  walking, `SELECT *` handled via `catalog.json`, unresolvable cases marked
  "unknown" rather than guessed wrong).

If revisited: spike Polyglot's `lineage()` specifically (not just its parser
parity) against real compiled Redshift SQL before committing; fall back to
the `node-sql-parser` heuristic if it underdelivers. See git history of this
file for the original full design (toggle UX, `ViewState` changes,
`columnLineage.ts` module shape) — kept lightweight here since this track
is not currently being built.
