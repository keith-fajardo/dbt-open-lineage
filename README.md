# dbt-open-lineage

A monorepo for dbt Open Lineage tooling.

## Packages

- `packages/core` — Core lineage engine
- `packages/vscode` — VSCode extension
- `packages/mext` — Mnemo extension
- `packages/cli` — generates a static, read-only DAG viewer from `manifest.json`, for CI-driven hosting

## Development

```bash
npm install
npm run build
npm run test
```
