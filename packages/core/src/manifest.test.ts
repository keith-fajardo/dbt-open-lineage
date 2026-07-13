import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseManifest } from "./manifest";

const fixture = () => readFileSync(resolve(__dirname, "../test/fixtures/manifest.min.json"), "utf8");

describe("parseManifest", () => {
  it("keeps model/source, drops test nodes from the graph", () => {
    const g = parseManifest(fixture());
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("model.proj.stg_orders");
    expect(ids).toContain("source.proj.raw.orders");
    expect(ids.some((i) => i.startsWith("test."))).toBe(false);
    expect(g.nodes.length).toBe(3); // 2 models + 1 source
  });

  it("infers layer from path", () => {
    const g = parseManifest(fixture());
    const layer = (id: string) => g.nodes.find((n) => n.id === id)!.layer;
    expect(layer("source.proj.raw.orders")).toBe("source");
    expect(layer("model.proj.stg_orders")).toBe("staging");
    expect(layer("model.proj.mrt_orders")).toBe("mart");
  });

  it("populates tags/materialized/meta from config", () => {
    const g = parseManifest(fixture());
    const n = g.nodes.find((x) => x.id === "model.proj.mrt_orders")!;
    expect(n.tags).toEqual(["mart", "daily"]);
    expect(n.materialized).toBe("table");
    expect(n.meta).toEqual({});
    const s = g.nodes.find((x) => x.id === "model.proj.stg_orders")!;
    expect(s.materialized).toBe("view");
    expect(s.meta).toEqual({ owner: "data" });
  });

  it("rolls test names up onto their referenced model, not as nodes", () => {
    const g = parseManifest(fixture());
    const stg = g.nodes.find((x) => x.id === "model.proj.stg_orders")!;
    expect(stg.tests).toEqual(["not_null_stg_orders_id"]);
  });

  it("builds edges only between kept nodes (no test edges)", () => {
    const g = parseManifest(fixture());
    expect(g.edges).toContainEqual({ from: "source.proj.raw.orders", to: "model.proj.stg_orders" });
    expect(g.edges.some((e) => e.to.startsWith("test."))).toBe(false);
    expect(g.edges.length).toBe(2);
  });

  it("throws on bad json", () => {
    expect(() => parseManifest("not json")).toThrow();
  });
});

describe("patch_path", () => {
  it("strips the project:// prefix to a project-relative path", () => {
    const json = JSON.stringify({
      nodes: {
        "model.proj.stg_orders": {
          name: "stg_orders", resource_type: "model",
          original_file_path: "models/staging/stg_orders.sql",
          patch_path: "proj://models/staging/_stg__models.yml",
        },
      },
    });
    const g = parseManifest(json);
    expect(g.nodes[0].patch_path).toBe("models/staging/_stg__models.yml");
  });

  it("leaves patch_path undefined when the node has none", () => {
    const json = JSON.stringify({
      nodes: { "model.proj.x": { name: "x", resource_type: "model", original_file_path: "models/x.sql" } },
    });
    expect(parseManifest(json).nodes[0].patch_path).toBeUndefined();
  });
});
