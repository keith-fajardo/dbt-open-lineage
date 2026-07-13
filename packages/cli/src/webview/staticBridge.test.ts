import { describe, it, expect, vi } from "vitest";
import type { Graph } from "@dbt-open-lineage/core";
import { createStaticBridge } from "./staticBridge";

const graph: Graph = { nodes: [{ id: "model.a", name: "a", resource_type: "model", layer: "staging", path: "a.sql", description: "" }], edges: [] };

describe("createStaticBridge", () => {
  it("resolves dbt.manifest and dbt.compile with the embedded graph", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.invoke("dbt.manifest", {})).toBe(graph);
    expect(await bridge.invoke("dbt.compile", {})).toBe(graph);
  });

  it("resolves fs.readText with the embedded sidecar text", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: "subject_areas:\n  core: {}\n" });
    expect(await bridge.invoke("fs.readText", { path: "anything" })).toBe("subject_areas:\n  core: {}\n");
  });

  it("resolves fs.readText with null when there is no sidecar", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.invoke("fs.readText", { path: "anything" })).toBeNull();
  });

  it("rejects unknown/write commands", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    await expect(bridge.invoke("fs.writeText", {})).rejects.toThrow(/read-only/i);
    await expect(bridge.invoke("dbt.gist", {})).rejects.toThrow(/read-only/i);
  });

  it("openInIde resolves false (no IDE in a static site)", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.openInIde("some/path")).toBe(false);
  });

  it("onContext returns an unsubscribe that never fires (no live host to push context)", () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    const cb = vi.fn();
    const unsubscribe = bridge.onContext(cb);
    unsubscribe();
    expect(cb).not.toHaveBeenCalled();
  });

  it("saveExport triggers a browser download and resolves true", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    const clickSpy = vi.fn();
    const createElSpy = vi.spyOn(document, "createElement").mockReturnValue({ click: clickSpy } as unknown as HTMLAnchorElement);
    const result = await bridge.saveExport("dag.csv", "aGVsbG8=");
    expect(result).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();
    createElSpy.mockRestore();
  });
});
