// Moved to @dbt-open-lineage/core (shared with packages/cli). Subpath import
// (not the package barrel) so esbuild doesn't pull core's React/App tree
// into this Node-only extension-host bundle — see the barrel's comment.
export { parseManifest } from "@dbt-open-lineage/core/src/manifest";
