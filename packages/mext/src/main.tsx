import { mountApp } from "@dbt-open-lineage/core";
import "@xyflow/react/dist/style.css";
import { mextBridge } from "./bridge";

// The host (Mnemo's ExtensionHost) injects the target project path — and
// optionally an initial selector ("context", e.g. "+dim_date+" from the IDE's
// Lineage panel) — into the URL hash when it loads this bundle's entry into
// the sandboxed iframe. Same hash keys as the pre-monorepo mext main.tsx.
const hash = new URLSearchParams(location.hash.slice(1));
mountApp(document.getElementById("root")!, {
  bridge: mextBridge,
  projectPath: decodeURIComponent(hash.get("projectPath") ?? ""),
  initialSelector: decodeURIComponent(hash.get("context") ?? ""),
});
