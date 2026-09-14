import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "path";
import { traceColumnCommand, resolveNodeId } from "./traceColumn";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import { parseManifest } from "@dbt-open-lineage/core/src/manifest";
import { readFileSync } from "fs";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);

const manifestPath = resolve(__dirname, "../test/fixtures/manifest.min.json");

// stg_orders.order_id -> fct_orders.order_id, a straight one-hop chain.
const payload = {
  nodes: {
    "model.proj.stg_orders": { columns: { order_id: { columnName: "order_id", hasLineage: true } } },
    "model.proj.fct_orders": { columns: { order_id: { columnName: "order_id", hasLineage: true } } },
  },
  edges: [
    { source: "model.proj.stg_orders", target: "model.proj.fct_orders", sourceColumn: "order_id", targetColumn: "order_id" },
  ],
};

beforeEach(() => {
  mockedRunColibri.mockResolvedValue(payload);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveNodeId", () => {
  const graph = parseManifest(readFileSync(manifestPath, "utf8"));

  it("resolves a unique model name to its unique_id", () => {
    expect(resolveNodeId(graph, "stg_orders")).toBe("model.proj.stg_orders");
  });

  it("throws when no node has that name", () => {
    expect(() => resolveNodeId(graph, "nope")).toThrow(/no node named "nope"/);
  });

  it("throws listing candidates when the name is ambiguous", () => {
    const dup = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0] }] };
    expect(() => resolveNodeId(dup, "stg_orders")).toThrow(/ambiguous/);
  });
});

describe("traceColumnCommand", () => {
  it("traces a column by --model, returning endpoints and edges", async () => {
    const result = await traceColumnCommand({
      manifestPath, catalogPath: "catalog.json", model: "stg_orders", column: "order_id",
    });
    expect(result.start).toEqual({ node: "model.proj.stg_orders", column: "order_id" });
    expect(result.endpoints).toEqual([
      { node: "model.proj.fct_orders", column: "order_id" },
      { node: "model.proj.stg_orders", column: "order_id" },
    ]);
    expect(result.edges).toEqual(payload.edges);
    expect(mockedRunColibri).toHaveBeenCalledWith({ manifestPath, catalogPath: "catalog.json" });
  });

  it("traces a column by --node directly, skipping model-name resolution", async () => {
    const result = await traceColumnCommand({
      manifestPath, catalogPath: "catalog.json", node: "model.proj.fct_orders", column: "order_id",
    });
    expect(result.start).toEqual({ node: "model.proj.fct_orders", column: "order_id" });
  });

  it("throws when the manifest doesn't exist", async () => {
    await expect(traceColumnCommand({
      manifestPath: resolve(__dirname, "../test/fixtures/nope.json"), catalogPath: "catalog.json", model: "stg_orders", column: "order_id",
    })).rejects.toThrow(/manifest not found/i);
  });

  it("throws when neither --node nor --model is given", async () => {
    await expect(traceColumnCommand({
      manifestPath, catalogPath: "catalog.json", column: "order_id",
    })).rejects.toThrow(/either --node or --model is required/);
  });

  it("throws a clear error when the resolved node has no column-lineage data", async () => {
    await expect(traceColumnCommand({
      manifestPath, catalogPath: "catalog.json", node: "model.proj.does_not_exist", column: "order_id",
    })).rejects.toThrow(/no column-lineage data for node "model.proj.does_not_exist"/);
  });

  it("throws a clear error, listing available columns, when the column doesn't exist on the node", async () => {
    await expect(traceColumnCommand({
      manifestPath, catalogPath: "catalog.json", model: "stg_orders", column: "nope",
    })).rejects.toThrow(/column "nope" not found on "model.proj.stg_orders"\. Available columns: order_id/);
  });
});
