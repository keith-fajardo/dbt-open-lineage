import { describe, it, expect } from "vitest";
import { computeFiltered, computeActiveIds } from "./filters";

const nodes = [
  { id: "a", meta: { labels: ["core"], subject_areas: ["orders"] }, tags: ["nightly"] },
  { id: "b", meta: { labels: ["revenue"], subject_areas: ["orders", "finance"] }, tags: ["nightly"] },
  { id: "c", meta: {}, tags: ["adhoc"] },
];
const none = { favActive: false, favorites: new Set<string>(), labels: new Set<string>(), tags: new Set<string>(), areas: new Set<string>() };

describe("computeFiltered", () => {
  it("returns null when no category is active", () => {
    expect(computeFiltered(nodes, none)).toBeNull();
  });
  it("favorites only", () => {
    expect(computeFiltered(nodes, { ...none, favActive: true, favorites: new Set(["b"]) })).toEqual(new Set(["b"]));
  });
  it("labels only (OR within category)", () => {
    expect(computeFiltered(nodes, { ...none, labels: new Set(["core", "revenue"]) })).toEqual(new Set(["a", "b"]));
  });
  it("tags only", () => {
    expect(computeFiltered(nodes, { ...none, tags: new Set(["adhoc"]) })).toEqual(new Set(["c"]));
  });
  it("subject areas only (OR within category)", () => {
    expect(computeFiltered(nodes, { ...none, areas: new Set(["orders"]) })).toEqual(new Set(["a", "b"]));
    expect(computeFiltered(nodes, { ...none, areas: new Set(["finance"]) })).toEqual(new Set(["b"]));
  });
  it("AND across categories", () => {
    // nightly tag AND core label → only a
    expect(computeFiltered(nodes, { ...none, tags: new Set(["nightly"]), labels: new Set(["core"]) })).toEqual(new Set(["a"]));
  });
});

describe("computeActiveIds", () => {
  it("both channels inactive (null) -> empty set, NOT 'everything'", () => {
    // A blank selector must never fall back to "the whole graph" — the DAG
    // itself renders nothing when the selector is blank (see App.tsx), so
    // Run must have nothing to act on either.
    expect(computeActiveIds(null, null)).toEqual(new Set());
  });

  it("selector only -> the matched set, even if it's empty", () => {
    expect(computeActiveIds(new Set(["a"]), null)).toEqual(new Set(["a"]));
    expect(computeActiveIds(new Set(), null)).toEqual(new Set());
  });

  it("filter only -> the filtered set, even if it's empty", () => {
    expect(computeActiveIds(null, new Set(["b"]))).toEqual(new Set(["b"]));
    expect(computeActiveIds(null, new Set())).toEqual(new Set());
  });

  it("both active -> the UNION of the two sets", () => {
    expect(computeActiveIds(new Set(["a"]), new Set(["b"]))).toEqual(new Set(["a", "b"]));
  });

  it("both active with overlap -> no duplicate double-counting (still a Set)", () => {
    expect(computeActiveIds(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual(new Set(["a", "b", "c"]));
  });
});
