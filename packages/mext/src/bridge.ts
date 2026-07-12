import type { Bridge } from "@dbt-open-lineage/core";

// Bridge client: postMessage to the Mnemo host (the sandboxed iframe's
// parent), await a matching reply. Both listeners below check
// `ev.source === window.parent` — the iframe has an opaque/permissive origin
// (postMessage target "*"), so this is the only thing standing between the
// extension and a spoofed reply/context push from some other embedded frame.
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window.parent) return;
  const msg = ev.data;
  if (!msg || typeof msg.id !== "number" || !("ok" in msg)) return;
  const p = pending.get(msg.id); if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result); else p.reject(new Error(String(msg.error ?? "host error")));
});

export const mextBridge: Bridge = {
  invoke: (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, cmd, args }, "*");
  }),
  saveExport: (filename, dataB64) => mextBridge.invoke("export.save", { filename, dataB64 }),
  openInIde: (path) => mextBridge.invoke("ide.open", { path }),
  onContext: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.evt !== "context" || typeof m.value !== "string") return;
      cb(m.value);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
};
