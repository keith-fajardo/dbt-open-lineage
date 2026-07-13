import type { StaticPageData } from "./webview/staticBridge";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Renders the final static index.html: the prebuilt JS/CSS bundle
 * (packages/cli/dist/webview/assets, copied alongside by generate.ts) plus
 * this run's graph/sidecar data inlined as JSON. The `<` escape mirrors
 * packages/vscode/src/webview/panel.ts's buildHtml — same reason: a sidecar
 * or gist containing "</script>" must not break out of the data script tag. */
export function buildHtml(data: StaticPageData): string {
  const title = data.title ? escapeHtml(data.title) : "dbt Lineage";
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<title>${title}</title>
<link rel="stylesheet" href="./assets/main.css" />
</head><body style="margin:0"><div id="root"></div>
<script>window.__DOL_STATIC_DATA__=${json};</script>
<script type="module" src="./assets/main.js"></script>
</body></html>`;
}
