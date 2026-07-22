/** Host access surface. The consumer (VSCode ext / Mnemo mext) supplies an
 * implementation via setBridge() before mounting; core never imports a host. */
import type { RunEvent } from "./runStatus";

export interface Bridge {
  invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T>;
  saveExport(filename: string, dataB64: string): Promise<boolean>;
  openInIde(path: string): Promise<boolean>;
  onContext(cb: (value: string) => void): () => void;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
  /** Optional: hosts that watch target/manifest.json push this when an
   * EXTERNAL `dbt compile` rewrites it. Optional so hosts without a watcher
   * (Mnemo, static CLI) keep satisfying the interface unchanged. */
  onManifestChanged?(cb: () => void): () => void;
}

let active: Bridge | null = null;
export function setBridge(b: Bridge): void { active = b; }
function get(): Bridge {
  if (!active) throw new Error("dbt-open-lineage: bridge not set (call setBridge first)");
  return active;
}

export const invoke = <T>(cmd: string, args: Record<string, unknown>): Promise<T> => get().invoke<T>(cmd, args);
export const saveExport = (filename: string, dataB64: string): Promise<boolean> => get().saveExport(filename, dataB64);
export const openInIde = (path: string): Promise<boolean> => get().openInIde(path);
export const onContext = (cb: (value: string) => void): () => void => get().onContext(cb);
export const onRunEvent = (cb: (e: RunEvent) => void): (() => void) => get().onRunEvent(cb);
export const onManifestChanged = (cb: () => void): (() => void) => {
  const b = get();
  // Host without a watcher: subscribing is a no-op with a no-op unsubscribe.
  return b.onManifestChanged ? b.onManifestChanged(cb) : () => {};
};
