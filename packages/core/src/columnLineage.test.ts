import { describe, it, expect } from "vitest";
import { extractColumnLineage } from "./columnLineage";

const RAW_COLIBRI_MANIFEST = {
  metadata: { adapter_type: "redshift" },
  nodes: {
    "model.proj.stg_orders": {
      columns: {
        order_id: { columnName: "order_id", hasLineage: true, lineageType: "unknown" },
        raw_json: { columnName: "raw_json", hasLineage: false },
      },
    },
    "model.proj.mrt_orders": {
      columns: {
        order_id: { columnName: "order_id", hasLineage: true, lineageType: "transformation" },
      },
    },
  },
  lineage: {
    edges: [
      { id: 1, source: "model.proj.stg_orders", target: "model.proj.mrt_orders", sourceColumn: "order_id", targetColumn: "order_id" },
      { id: 2, source: "model.proj.stg_orders", target: "model.proj.mrt_orders", sourceColumn: "", targetColumn: "" },
      { id: 3, source: "model.proj.stg_orders", target: "model.proj.mrt_orders", sourceColumn: "order_id", targetColumn: "", edgeType: "join" },
    ],
  },
};

describe("extractColumnLineage", () => {
  it("keeps each node's columns with hasLineage/lineageType", () => {
    const result = extractColumnLineage(RAW_COLIBRI_MANIFEST);
    expect(result.nodes["model.proj.stg_orders"].columns.order_id).toEqual({
      columnName: "order_id", hasLineage: true, lineageType: "unknown",
    });
    expect(result.nodes["model.proj.stg_orders"].columns.raw_json).toEqual({
      columnName: "raw_json", hasLineage: false,
    });
  });

  it("keeps only real column-to-column edges (both columns non-empty, no edgeType)", () => {
    const result = extractColumnLineage(RAW_COLIBRI_MANIFEST);
    expect(result.edges).toEqual([
      { source: "model.proj.stg_orders", target: "model.proj.mrt_orders", sourceColumn: "order_id", targetColumn: "order_id" },
    ]);
  });

  it("drops model-level dependency edges (empty source/target columns)", () => {
    const result = extractColumnLineage(RAW_COLIBRI_MANIFEST);
    expect(result.edges.some((e) => e.sourceColumn === "" || e.targetColumn === "")).toBe(false);
  });

  it("drops structural join/filter edges (edgeType set)", () => {
    const result = extractColumnLineage(RAW_COLIBRI_MANIFEST);
    expect(result.edges.some((e) => "edgeType" in e)).toBe(false);
  });

  it("handles missing nodes/lineage gracefully", () => {
    expect(extractColumnLineage({})).toEqual({ nodes: {}, edges: [] });
  });
});
