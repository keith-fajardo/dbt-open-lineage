import { describe, it, expect } from "vitest";
import { contextValueForEditor } from "./context";
import type { Graph } from "@dbt-open-lineage/core";

const g: Graph = { nodes: [
  { id: "model.p.stg_orders", name: "stg_orders", resource_type: "model", layer: "staging", path: "models/staging/stg_orders.sql", description: "" },
], edges: [] };

describe("contextValueForEditor", () => {
  it("returns +name+ for a model file in the graph", () => {
    expect(contextValueForEditor(g, "/repo/dbt", "/repo/dbt/models/staging/stg_orders.sql")).toBe("+stg_orders+");
  });
  it("returns null for a non-model file", () => {
    expect(contextValueForEditor(g, "/repo/dbt", "/repo/dbt/README.md")).toBeNull();
  });
});
