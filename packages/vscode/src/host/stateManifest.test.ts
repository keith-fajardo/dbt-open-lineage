import { describe, expect, it } from "vitest";
import { resolveLocalStateModified } from "./stateManifest";

function manifests() {
  const previous = {
    nodes: {
      "model.proj.stg_orders": {
        resource_type: "model", raw_code: "select * from source('raw', 'orders')",
        checksum: { checksum: "stg-v1" }, depends_on: { macros: ["macro.proj.normalise"] },
      },
      "model.proj.mrt_orders": {
        resource_type: "model", raw_code: "select * from ref('stg_orders')", checksum: { checksum: "mrt-v1" },
      },
      "test.proj.stg_orders": { resource_type: "test", raw_code: "test" },
    },
    sources: {
      "source.proj.raw.orders": { resource_type: "source", checksum: { checksum: "source-v1" } },
    },
    macros: {
      "macro.proj.normalise": { macro_sql: "{% macro normalise() %} lower(x) {% endmacro %}" },
    },
    child_map: {
      "source.proj.raw.orders": ["model.proj.stg_orders"],
      "model.proj.stg_orders": ["model.proj.mrt_orders", "test.proj.stg_orders"],
      "model.proj.mrt_orders": [],
    },
  };
  return { previous, current: structuredClone(previous) };
}

describe("resolveLocalStateModified", () => {
  it("finds a changed model and its downstream graph nodes for state:modified+", () => {
    const { previous, current } = manifests();
    current.nodes["model.proj.stg_orders"].raw_code = "select id from source('raw', 'orders')";

    expect(resolveLocalStateModified(current, previous, "state:modified+")).toEqual({
      modifiedCount: 1,
      ids: ["model.proj.mrt_orders", "model.proj.stg_orders"],
    });
  });

  it("detects new resources and honours finite ancestors and descendants", () => {
    const { previous, current } = manifests();
    current.nodes["model.proj.int_orders"] = {
      resource_type: "model", raw_code: "select * from ref('stg_orders')", checksum: { checksum: "int-v1" },
    };
    current.child_map["model.proj.stg_orders"] = ["model.proj.int_orders"];
    current.child_map["model.proj.int_orders"] = ["model.proj.mrt_orders"];

    expect(resolveLocalStateModified(current, previous, "1+state:modified+1")).toEqual({
      modifiedCount: 1,
      ids: ["model.proj.int_orders", "model.proj.mrt_orders", "model.proj.stg_orders"],
    });
  });

  it("marks models that invoke a changed macro, including indirect macro dependencies", () => {
    const { previous, current } = manifests();
    current.macros["macro.proj.normalise"].macro_sql = "{% macro normalise() %} upper(x) {% endmacro %}";
    current.macros["macro.proj.wrapper"] = {
      macro_sql: "{% macro wrapper() %} {{ normalise() }} {% endmacro %}",
      depends_on: { macros: ["macro.proj.normalise"] },
    };
    current.nodes["model.proj.stg_orders"].depends_on = { macros: ["macro.proj.wrapper"] };

    expect(resolveLocalStateModified(current, previous, "state:modified")).toEqual({
      modifiedCount: 1,
      ids: ["model.proj.stg_orders"],
    });
  });

  it("does not treat generated compiled SQL as a modification", () => {
    const { previous, current } = manifests();
    current.nodes["model.proj.stg_orders"].compiled_code = "select * from db.raw.orders";

    expect(resolveLocalStateModified(current, previous, "state:modified")).toEqual({
      modifiedCount: 0,
      ids: [],
    });
  });

  it("resolves body-only changes locally and ignores config and macro changes", () => {
    const { previous, current } = manifests();
    current.nodes["model.proj.stg_orders"].config = { materialized: "table" };
    current.macros["macro.proj.normalise"].macro_sql = "{% macro normalise() %} upper(x) {% endmacro %}";
    expect(resolveLocalStateModified(current, previous, "state:modified.body+")).toEqual({
      modifiedCount: 0,
      ids: [],
    });

    current.nodes["model.proj.stg_orders"].raw_code = "select id from source('raw', 'orders')";
    expect(resolveLocalStateModified(current, previous, "state:modified.body")).toEqual({
      modifiedCount: 1,
      ids: ["model.proj.stg_orders"],
    });
  });

  it("defers richer selector grammar to dbt", () => {
    const { previous, current } = manifests();
    expect(resolveLocalStateModified(current, previous, "state:modified+ --exclude tag:wip")).toBeUndefined();
    expect(resolveLocalStateModified(current, previous, "state:modified+,tag:mart")).toBeUndefined();
  });
});
