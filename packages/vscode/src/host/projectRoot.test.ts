import { describe, it, expect } from "vitest";
import { findProjectRoot, nodeIdForFile } from "./projectRoot";
import type { Graph } from "@dbt-open-lineage/core";

describe("findProjectRoot", () => {
  it("walks up to the dir containing dbt_project.yml", () => {
    const present = new Set(["/repo/dbt/dbt_project.yml"]);
    const exists = (p: string) => present.has(p);
    expect(findProjectRoot("/repo/dbt/models/staging", exists)).toBe("/repo/dbt");
  });
  it("returns null when none found", () => {
    expect(findProjectRoot("/a/b/c", () => false)).toBeNull();
  });
});

describe("nodeIdForFile", () => {
  const g: Graph = { nodes: [
    { id: "model.p.stg_orders", name: "stg_orders", resource_type: "model", layer: "staging", path: "models/staging/stg_orders.sql", description: "" },
  ], edges: [] };
  it("maps an absolute file to its node name", () => {
    expect(nodeIdForFile(g, "/repo/dbt", "/repo/dbt/models/staging/stg_orders.sql")).toBe("stg_orders");
  });
  it("returns null for a file not in the graph", () => {
    expect(nodeIdForFile(g, "/repo/dbt", "/repo/dbt/models/other.sql")).toBeNull();
  });
});
