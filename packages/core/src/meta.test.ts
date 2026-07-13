import { describe, it, expect } from "vitest";
import { readMeta } from "./meta";

describe("readMeta", () => {
  it("returns the nested dbt_open_lineage value when present", () => {
    const meta = { dbt_open_lineage: { gist: "new gist" } };
    expect(readMeta(meta, "gist")).toBe("new gist");
  });

  it("falls back to the legacy flat key when the nested key is absent", () => {
    const meta = { gist: "legacy gist" };
    expect(readMeta(meta, "gist")).toBe("legacy gist");
  });

  it("prefers the nested value when both nested and legacy are present", () => {
    const meta = { dbt_open_lineage: { gist: "new" }, gist: "old" };
    expect(readMeta(meta, "gist")).toBe("new");
  });

  it("returns an explicit nested value even when falsy (empty string), not the legacy one", () => {
    const meta = { dbt_open_lineage: { gist: "" }, gist: "old" };
    expect(readMeta(meta, "gist")).toBe("");
  });

  it("returns undefined when the key exists at neither location", () => {
    expect(readMeta({}, "gist")).toBeUndefined();
    expect(readMeta(undefined, "gist")).toBeUndefined();
  });

  it("works for list-shaped keys (subject_areas, labels) the same way", () => {
    expect(readMeta({ dbt_open_lineage: { subject_areas: ["a"] } }, "subject_areas")).toEqual(["a"]);
    expect(readMeta({ subject_areas: ["b"] }, "subject_areas")).toEqual(["b"]);
  });

  it("falls back to legacy key when dbt_open_lineage is a non-object truthy value (string)", () => {
    const meta = { dbt_open_lineage: "not an object", gist: "legacy" };
    expect(readMeta(meta, "gist")).toBe("legacy");
  });

  it("falls back to legacy key when dbt_open_lineage is a non-object truthy value (boolean)", () => {
    const meta = { dbt_open_lineage: true, gist: "legacy" };
    expect(readMeta(meta, "gist")).toBe("legacy");
  });

  it("falls back to legacy key when dbt_open_lineage is a non-object truthy value (number)", () => {
    const meta = { dbt_open_lineage: 5, gist: "legacy" };
    expect(readMeta(meta, "gist")).toBe("legacy");
  });
});
