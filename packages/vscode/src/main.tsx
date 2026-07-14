import { mountApp } from "@dbt-open-lineage/core";
import "@xyflow/react/dist/style.css";
import { vscodeBridge } from "./bridge";

// The extension host injects the initial context via a nonce'd inline script
// (see src/webview/panel.ts's buildHtml) as window.__DOL_INIT__.
const cfg = (window as unknown as { __DOL_INIT__?: { projectPath: string; initialSelector?: string } }).__DOL_INIT__ ?? { projectPath: "" };
mountApp(document.getElementById("root")!, { bridge: vscodeBridge, canRun: true, ...cfg });
