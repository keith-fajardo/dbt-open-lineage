import { describe, it, expect } from "vitest";
import { resolveSelector, focalName, buildSelector } from "./selector";
import type { Graph } from "./graphTypes";

// a → b → c → d   (linear chain by name), with method-selector metadata:
// tags: b,c = nightly; materialization: c = table (rest unset);
// meta: b = {owner: "finance", pii: true}, c = {owner: {team: "data"}}.
const g: Graph = {
  nodes: ["a", "b", "c", "d"].map((n) => ({
    id: n, name: n, resource_type: "model", layer: "staging", path: "", description: "",
    tags: n === "b" || n === "c" ? ["nightly"] : [],
    materialized: n === "c" ? "table" : "",
    meta: n === "b" ? { owner: "finance", pii: true }
      : n === "c" ? { owner: { team: "data" } } : {},
  })),
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ],
};
const ids = (q: string) => [...resolveSelector(g, q)].sort();

describe("resolveSelector", () => {
  it("empty query = whole graph", () => expect(ids("")).toEqual(["a", "b", "c", "d"]));
  it("bare name = just that node", () => expect(ids("b")).toEqual(["b"]));
  it("model+ = node + all descendants", () => expect(ids("b+")).toEqual(["b", "c", "d"]));
  it("+model = all ancestors + node", () => expect(ids("+c")).toEqual(["a", "b", "c"]));
  it("+model+ = ancestors + node + descendants", () => expect(ids("+b+")).toEqual(["a", "b", "c", "d"]));
  it("model+N = N hops down", () => expect(ids("a+2")).toEqual(["a", "b", "c"]));
  it("N+model = N hops up", () => expect(ids("2+d")).toEqual(["b", "c", "d"]));
  it("union of terms", () => expect(ids("a b")).toEqual(["a", "b"]));
  it("unknown name = empty set", () => expect(ids("zzz")).toEqual([]));
  // dbt comma = intersection: "a+,+d" is the path FROM a TO d.
  it("comma intersects (path between two models)", () =>
    expect(ids("a+,+d")).toEqual(["a", "b", "c", "d"]));
  it("comma intersection narrows to the overlap only", () =>
    expect(ids("a+2,2+d")).toEqual(["b", "c"]));
  it("comma with a non-overlapping pair = empty set", () =>
    expect(ids("a,d")).toEqual([]));
  it("intersection tokens still union with other tokens", () =>
    expect(ids("a+2,2+d a")).toEqual(["a", "b", "c"]));
  it("stray commas are ignored", () => expect(ids("a,,b+,")).toEqual([]));

  // dbt method selectors
  it("tag: matches every node carrying the tag", () => expect(ids("tag:nightly")).toEqual(["b", "c"]));
  it("tag: composes with hops", () => expect(ids("+tag:nightly")).toEqual(["a", "b", "c"]));
  it("config.materialized: matches", () => expect(ids("config.materialized:table")).toEqual(["c"]));
  it("config.meta.<key>: matches strings", () => expect(ids("config.meta.owner:finance")).toEqual(["b"]));
  it("config.meta matches non-string values textually", () => expect(ids("config.meta.pii:true")).toEqual(["b"]));
  it("config.meta supports nested keys", () => expect(ids("config.meta.owner.team:data")).toEqual(["c"]));
  it("methods intersect with commas", () => expect(ids("tag:nightly,config.materialized:table")).toEqual(["c"]));
  it("unknown method = empty set", () => expect(ids("owner:finance")).toEqual([]));

  // --exclude: subtract a second selector from the selection (dbt-style).
  it("--exclude subtracts by name", () => expect(ids("a+ --exclude b")).toEqual(["a", "c", "d"]));
  it("--exclude subtracts by method", () =>
    expect(ids("a+ --exclude config.materialized:table")).toEqual(["a", "b", "d"]));
  it("--exclude works with hops", () => expect(ids("a+ --exclude 2+d")).toEqual(["a"]));
  it("bare --exclude means everything except the excluded", () =>
    expect(ids("--exclude tag:nightly")).toEqual(["a", "d"]));
  it("multiple --exclude flags union", () =>
    expect(ids("+d --exclude a --exclude b")).toEqual(["c", "d"]));
  it("trailing --exclude with nothing after it excludes nothing", () =>
    expect(ids("a --exclude")).toEqual(["a"]));

  // unused:sources — sources with no downstream consumers at all.
  const gs: Graph = {
    nodes: [
      { id: "s_used", name: "s_used", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "s_orphan", name: "s_orphan", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "s_lonely", name: "s_lonely", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "m1", name: "m1", resource_type: "model", layer: "staging", path: "", description: "" },
    ],
    edges: [{ from: "s_used", to: "m1" }],
  };
  const ids2 = (q: string) => [...resolveSelector(gs, q)].sort();

  it("unused:sources selects only sources with no downstream models", () =>
    expect(ids2("unused:sources")).toEqual(["s_lonely", "s_orphan"]));
  it("--exclude unused:sources hides them from the graph", () =>
    expect(ids2("--exclude unused:sources")).toEqual(["m1", "s_used"]));
  it("unused with any other value matches nothing", () =>
    expect(ids2("unused:models")).toEqual([]));
  it("unused sources never include a model without consumers", () =>
    // m1 has no downstream either, but it's a model — not a source.
    expect(ids2("unused:sources").includes("m1")).toBe(false));

  // resource_type: — dbt's `resource_type:<type>` method (docs: node-selection
  // /methods). The graph only holds model/seed/snapshot/source, so those are
  // the meaningful values; anything else (test/exposure/…) matches nothing.
  const gr: Graph = {
    nodes: [
      { id: "src.o", name: "raw_orders", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "seed.c", name: "countries", resource_type: "seed", layer: "model", path: "", description: "" },
      { id: "snap.o", name: "orders_snapshot", resource_type: "snapshot", layer: "snapshot", path: "", description: "" },
      { id: "mod.a", name: "stg_orders", resource_type: "model", layer: "staging", path: "", description: "" },
      { id: "mod.b", name: "fct_orders", resource_type: "model", layer: "mart", path: "", description: "" },
    ],
    edges: [{ from: "src.o", to: "mod.a" }, { from: "mod.a", to: "mod.b" }],
  };
  const ids3 = (q: string) => [...resolveSelector(gr, q)].sort();

  it("resource_type:source selects only sources", () =>
    expect(ids3("resource_type:source")).toEqual(["src.o"]));
  it("resource_type:snapshot selects only snapshots", () =>
    expect(ids3("resource_type:snapshot")).toEqual(["snap.o"]));
  it("resource_type:seed selects only seeds", () =>
    expect(ids3("resource_type:seed")).toEqual(["seed.c"]));
  it("resource_type:model selects only models", () =>
    expect(ids3("resource_type:model")).toEqual(["mod.a", "mod.b"]));
  it("resource_type: composes with hops", () =>
    expect(ids3("resource_type:source+")).toEqual(["mod.a", "mod.b", "src.o"]));
  it("resource_type: composes with --exclude", () =>
    expect(ids3("--exclude resource_type:source")).toEqual(["mod.a", "mod.b", "seed.c", "snap.o"]));
  it("resource_type with a type absent from the graph matches nothing", () =>
    expect(ids3("resource_type:test")).toEqual([]));
});

describe("focalName — the open model behind a +model+ push", () => {
  it("strips the surrounding hop operators", () => {
    expect(focalName("+dim_date+")).toBe("dim_date");
    expect(focalName("2+dim_date+3")).toBe("dim_date");
    expect(focalName("dim_date")).toBe("dim_date");
  });
  it("returns '' for anything that doesn't name one focal model", () => {
    expect(focalName("")).toBe("");
    expect(focalName("tag:mart")).toBe("");         // method selector
    expect(focalName("a+ +b")).toBe("");            // multi-token
    expect(focalName("a+,+b")).toBe("");            // comma-intersection
  });
});

describe("buildSelector", () => {
  const rg: Graph = {
    nodes: [
      { id: "model.p.stg_orders", name: "stg_orders", resource_type: "model", layer: "staging", path: "", description: "" },
      { id: "seed.p.raw_countries", name: "raw_countries", resource_type: "seed", layer: "model", path: "", description: "" },
      { id: "snapshot.p.orders_snap", name: "orders_snap", resource_type: "snapshot", layer: "model", path: "", description: "" },
      { id: "source.p.raw.orders", name: "orders", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "test.p.not_null_x", name: "not_null_x", resource_type: "test", layer: "model", path: "", description: "" },
    ],
    edges: [],
  };

  it("joins the names of runnable nodes (model/seed/snapshot), sorted", () => {
    const ids = new Set(["model.p.stg_orders", "seed.p.raw_countries", "snapshot.p.orders_snap"]);
    expect(buildSelector(ids, rg)).toBe("orders_snap raw_countries stg_orders");
  });

  it("excludes sources and tests even if their ids are included", () => {
    const ids = new Set(["model.p.stg_orders", "source.p.raw.orders", "test.p.not_null_x"]);
    expect(buildSelector(ids, rg)).toBe("stg_orders");
  });

  it("empty selection produces an empty string", () => {
    expect(buildSelector(new Set(), rg)).toBe("");
  });

  it("a selection with only non-runnable ids produces an empty string", () => {
    expect(buildSelector(new Set(["source.p.raw.orders"]), rg)).toBe("");
  });
});

describe("unused:staging", () => {
  // s1 (stg_, leaf) unused; s2 (stg_, has child m) used; m (mart leaf) not
  // staging; sd (stg_-named but a seed) excluded by the model guard.
  const gst: Graph = {
    nodes: [
      { id: "s1", name: "stg_orphan", resource_type: "model", layer: "staging", path: "models/staging/stg_orphan.sql", description: "" },
      { id: "s2", name: "stg_used",   resource_type: "model", layer: "staging", path: "models/staging/stg_used.sql",   description: "" },
      { id: "m",  name: "mart_x",     resource_type: "model", layer: "mart",    path: "models/marts/mart_x.sql",       description: "" },
      { id: "sd", name: "stg_seed",   resource_type: "seed",  layer: "staging", path: "seeds/stg_seed.csv",            description: "" },
    ],
    edges: [{ from: "s2", to: "m" }],
  };
  const sids = (q: string) => [...resolveSelector(gst, q)].sort();

  it("matches a stg_-named model with no downstream consumers", () =>
    expect(sids("unused:staging")).toEqual(["s1"]));
  it("does NOT match a stg_ model that has a downstream consumer", () =>
    expect(sids("unused:staging")).not.toContain("s2"));
  it("does NOT match a non-stg_ leaf model", () =>
    expect(sids("unused:staging")).not.toContain("m"));
  it("does NOT match a stg_-named non-model (seed) — model guard", () =>
    expect(sids("unused:staging")).not.toContain("sd"));
  it("--exclude unused:staging subtracts the unused staging set", () =>
    // include by NAME (dbt selectors match names, not ids); s1's name is
    // stg_orphan (the unused staging one) → excluded, leaving s2 + m.
    expect(sids("stg_orphan stg_used mart_x --exclude unused:staging")).toEqual(["m", "s2"]));
});

describe("unused:intermediate", () => {
  // i1 (int_, leaf) unused; i2 (int_, has child m) used; m (mart leaf) not
  // intermediate; id_ (int_-named but a seed) excluded by the model guard.
  const gin: Graph = {
    nodes: [
      { id: "i1", name: "int_orphan", resource_type: "model", layer: "intermediate", path: "models/intermediate/int_orphan.sql", description: "" },
      { id: "i2", name: "int_used",   resource_type: "model", layer: "intermediate", path: "models/intermediate/int_used.sql",   description: "" },
      { id: "m",  name: "mart_x",     resource_type: "model", layer: "mart",         path: "models/marts/mart_x.sql",            description: "" },
      { id: "id_", name: "int_seed",  resource_type: "seed",  layer: "intermediate", path: "seeds/int_seed.csv",                 description: "" },
    ],
    edges: [{ from: "i2", to: "m" }],
  };
  const iids = (q: string) => [...resolveSelector(gin, q)].sort();

  it("matches an int_-named model with no downstream consumers", () =>
    expect(iids("unused:intermediate")).toEqual(["i1"]));
  it("does NOT match an int_ model that has a downstream consumer", () =>
    expect(iids("unused:intermediate")).not.toContain("i2"));
  it("does NOT match a non-int_ leaf model", () =>
    expect(iids("unused:intermediate")).not.toContain("m"));
  it("does NOT match an int_-named non-model (seed) — model guard", () =>
    expect(iids("unused:intermediate")).not.toContain("id_"));
  it("--exclude unused:intermediate subtracts the unused intermediate set", () =>
    expect(iids("int_orphan int_used mart_x --exclude unused:intermediate")).toEqual(["i2", "m"]));
});
