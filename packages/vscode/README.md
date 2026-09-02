# dbt Open Lineage

Interactive dbt lineage exploration inside VS Code.

dbt Open Lineage reads your dbt project's `target/manifest.json` and turns it into a navigable model graph. It is built for analytics engineers and data teams who want to understand upstream and downstream dependencies without leaving their editor.

## What It Helps You Do

- Explore dbt model lineage from the VS Code panel.
- Trace column-level lineage across models with dbt-colibri.
- Filter the graph with familiar dbt selector syntax.
- Inspect model metadata, descriptions, tests, tags, and materializations.
- Open model files directly from graph nodes.
- View compiled SQL beside the source model.
- Document models with descriptions, gists, labels, subject areas, and callouts.
- Export selected lineage as CSV, Mermaid, SVG, or PNG.

## Showcase

Use these sections to present the extension on the VS Code Marketplace.

### Lineage Graph

The main panel renders a left-to-right dbt DAG with sources, seeds, models, and their dependencies. Selecting a node highlights its lineage cone so you can quickly see what feeds it and what it feeds.

### Column-Level Lineage

Toggle **Columns** in the toolbar to expand nodes into their columns and trace lineage at the column level. Click a column to highlight its upstream sources and downstream consumers across models — following a single field end-to-end through the DAG.

Column lineage is computed with [dbt-colibri](https://pypi.org/project/dbt-colibri/) from your project's `manifest.json` and `catalog.json`, so it reflects the columns dbt actually resolved. It requires:

- `dbt-colibri` installed (see [Requirements](#requirements)).
- A generated catalog at `target/catalog.json` — run `dbt docs generate`.

### dbt Selector Filtering

Use dbt-style selectors to focus the graph:

```text
my_model+
tag:mart
stg_orders,dim_customer
config.materialized:view --exclude tag:deprecated
```

Press Enter to apply the selector — typing does not filter the graph until you commit with Enter, so it stays responsive on large projects. The **Focus** toggle controls what the applied selector does: on, the graph is filtered to just the matched models; off, non-matching models are dimmed while the full DAG stays visible. Leaving the selector blank and pressing Enter shows the whole graph, guarded by a confirmation prompt.

**Supported selection methods:**

| Syntax | Matches |
|---|---|
| `model_name` | Exact node by name. |
| `n+model` / `+model` | Up to `n` ancestor hops upstream (`+` alone = unlimited). |
| `model+n` / `model+` | Up to `n` descendant hops downstream (`+` alone = unlimited). |
| `+model+` | Both directions combined. |
| `a+,+d` | Intersection of two sub-selectors (path between `a` and `d`). |
| `a b` | Union — space-separated terms combine their matches. |
| `tag:value` | Nodes whose dbt `tags` include `value`. |
| `config.materialized:value` | Nodes with a matching `materialized` config. |
| `resource_type:value` | Nodes of a given dbt resource type (`model`, `seed`, `snapshot`, `source`). |
| `config.meta.a.b:value` | Dotted lookup into a node's `meta`. |
| `unused:sources` | Source nodes with no downstream consumers. |
| `--exclude <expr>` | Subtracts a second selector's matches from the result; repeatable. |
| `--full-refresh` | Not a filter — flags the run/build invocation for a full refresh. |

Toggle **Regex mode** to match node names against a JavaScript regular expression instead of dbt selector syntax (for example `^stg_|_test$`); the two modes are mutually exclusive.

### Search And Favorites

Search highlights matching nodes without changing the graph layout. Favorites let you mark models you return to often and filter back to them later.

### Model Details

Click a node to inspect:

- resource type
- materialization
- file path
- description
- dbt tags
- tests
- custom lineage metadata

Double-click a node to open its dbt model file in VS Code.

### Documentation Editing

The details panel can update dbt model YAML while preserving existing comments and formatting where possible. It writes extension-owned metadata under:

```yaml
config:
  meta:
    dbt_open_lineage:
      gist: "Short model summary"
      callout: true
      subject_areas:
        - order_ledger
      labels:
        - core
```

dbt tags are saved to dbt's native `config.tags`.

### Subject Areas, Labels, And Callouts

Group related models into visible subject-area zones, add colored label stripes, and show short callout notes directly on the DAG. Style names and colors can be managed with a `lineage.yml` file at your dbt project root.

Example:

```yaml
subject_areas:
  order_ledger:
    name: "Order Ledger"
    color: "#8b5cf6"

labels:
  core:
    name: "Core"
    color: "#22d3ee"
```

### Compiled SQL

From a dbt model file, run `dbt: Compile Model` to open the compiled SQL in a side editor. From the compiled SQL editor, run `dbt: Recompile Model` to refresh only that model with `dbt compile --select <model>`.

### Export

Export the current selection or visible scope as:

- CSV
- Mermaid `.mmd`
- SVG image
- PNG image

## Requirements

- VS Code `1.90.0` or newer.
- A dbt project containing `dbt_project.yml`.
- A generated dbt manifest at `target/manifest.json`.

If the manifest does not exist yet, run:

```bash
dbt compile
```

**For column-level lineage** additionally:

- [`dbt-colibri`](https://pypi.org/project/dbt-colibri/) installed (a project virtualenv at `.venv`/`venv` is auto-detected, otherwise it must be on `PATH`):

  ```bash
  pip install dbt-colibri
  ```

- A generated catalog at `target/catalog.json`:

  ```bash
  dbt docs generate
  ```

## Getting Started

1. Open a dbt project in VS Code.
2. Run `dbt compile` if `target/manifest.json` is missing.
3. Open the Command Palette.
4. Run `dbt: Open Lineage`.
5. Type a model name or selector in the lineage panel.

## Commands

| Command | Description |
|---|---|
| `dbt: Open Lineage` | Opens the dbt lineage panel. |
| `dbt: Compile Model` | Opens compiled SQL for the active dbt model. |
| `dbt: Recompile Model` | Re-runs compile for the model shown in the compiled SQL editor. |

## Settings

| Setting | Default | Description |
|---|---:|---|
| `dbt-open-lineage.projectRoot` | `""` | Absolute path to the dbt project root. Empty means auto-detect from the current workspace or file. |
| `dbt-open-lineage.ai.provider` | `claude-code` | AI CLI preset for the gist generation button. |
| `dbt-open-lineage.ai.command` | `claude -p "{prompt}"` | Command template used to draft a model gist. |

## AI Gist Generation

The gist button can call a local AI CLI to draft a short plain-English summary of the selected model. Configure `dbt-open-lineage.ai.command` if you use a different local CLI.

The command is tokenized and run without a shell. The `{prompt}` placeholder is passed as one argument.

## Notes

- The extension reads lineage from dbt's manifest, so the graph reflects the last successful dbt compile.
- Documentation edits write to dbt YAML files in the project.
- The Marketplace icon is included at `images/icon.png`.

## License

MIT
