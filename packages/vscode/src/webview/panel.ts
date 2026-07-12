import * as vscode from "vscode";

function nonce(): string {
  // 32 hex chars; Math.random is fine for a CSP nonce (not a secret).
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  init: { projectPath: string; initialSelector: string },
): string {
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
</head><body style="margin:0"><div id="root"></div>
<script nonce="${n}">window.__DOL_INIT__=${JSON.stringify(init).replace(/</g, "\\u003c")};</script>
<script nonce="${n}" type="module" src="${scriptUri}"></script>
</body></html>`;
}
