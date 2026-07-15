import type { Bridge } from "@dbt-open-lineage/core";
import type { Graph } from "@dbt-open-lineage/core";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

export interface StaticPageData {
  graph: Graph;
  sidecarText: string | null;
  title?: string;
  columnLineage?: ColumnLineagePayload;
}

function download(filename: string, dataB64: string): boolean {
  const a = document.createElement("a");
  a.href = `data:application/octet-stream;base64,${dataB64}`;
  a.download = filename;
  a.click();
  return true;
}

/** Bridge backed by data embedded at build time (see template.ts) instead
 * of a live host. Read-only: write commands reject rather than silently
 * no-op, as a safety net — their UI is hidden by App's readOnly mode, so
 * this should be unreachable in practice. */
export function createStaticBridge(data: StaticPageData): Bridge {
  return {
    invoke: <T>(cmd: string): Promise<T> => {
      if (cmd === "dbt.manifest" || cmd === "dbt.compile") return Promise.resolve(data.graph as unknown as T);
      if (cmd === "fs.readText") return Promise.resolve(data.sidecarText as unknown as T);
      return Promise.reject(new Error(`read-only viewer: "${cmd}" is not available`));
    },
    saveExport: (filename, dataB64) => Promise.resolve(download(filename, dataB64)),
    openInIde: () => Promise.resolve(false),
    onContext: () => () => {},
  };
}
