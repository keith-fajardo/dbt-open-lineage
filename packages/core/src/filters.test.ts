import { describe, it, expect } from "vitest";
import { computeFiltered } from "./filters";

const nodes = [
  { id: "a", meta: { labels: ["core"] }, tags: ["nightly"] },
  { id: "b", meta: { labels: ["revenue"] }, tags: ["nightly"] },
  { id: "c", meta: {}, tags: ["adhoc"] },
];
const none = { favActive: false, favorites: new Set<string>(), labels: new Set<string>(), tags: new Set<string>() };

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
  it("AND across categories", () => {
    // nightly tag AND core label → only a
    expect(computeFiltered(nodes, { ...none, tags: new Set(["nightly"]), labels: new Set(["core"]) })).toEqual(new Set(["a"]));
  });
});
