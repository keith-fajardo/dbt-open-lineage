import { describe, it, expect } from "vitest";
import { resolveSelector, focalName, buildSelector, hasStateSelector } from "./selector";
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

describe("source: method — dbt source selector by source group name", () => {
  // Source ids are source.<project>.<source_name>.<table>; node.name is only the
  // table. The source group (e.g. SALESFORCE_1_DEV) lives in id segment [2].
  const gsrc: Graph = {
    nodes: [
      { id: "source.p.SALESFORCE_1_DEV.BRANCH", name: "BRANCH", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "source.p.SALESFORCE_1_DEV.BRANCH_TYPE", name: "BRANCH_TYPE", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "source.p.SALESFORCE_2_PROD.ACCOUNT", name: "ACCOUNT", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "model.p.stg_branch", name: "stg_branch", resource_type: "model", layer: "staging", path: "", description: "" },
      { id: "model.p.rpt_branch", name: "rpt_branch", resource_type: "model", layer: "mart", path: "", description: "" },
    ],
    edges: [
      { from: "source.p.SALESFORCE_1_DEV.BRANCH", to: "model.p.stg_branch" },
      { from: "model.p.stg_branch", to: "model.p.rpt_branch" },
    ],
  };
  const sq = (q: string) => [...resolveSelector(gsrc, q)].sort();

  it("selects every table under a source group by its exact name", () =>
    expect(sq("source:SALESFORCE_1_DEV")).toEqual([
      "source.p.SALESFORCE_1_DEV.BRANCH", "source.p.SALESFORCE_1_DEV.BRANCH_TYPE",
    ]));
  it("globs the source group name", () =>
    expect(sq("source:*_1*")).toEqual([
      "source.p.SALESFORCE_1_DEV.BRANCH", "source.p.SALESFORCE_1_DEV.BRANCH_TYPE",
    ]));
  it("matches a specific table via source_name.table", () =>
    expect(sq("source:SALESFORCE_1_DEV.BRANCH")).toEqual(["source.p.SALESFORCE_1_DEV.BRANCH"]));
  it("composes with downstream hops to find dependents", () =>
    expect(sq("source:*_1*+")).toEqual([
      "model.p.rpt_branch", "model.p.stg_branch",
      "source.p.SALESFORCE_1_DEV.BRANCH", "source.p.SALESFORCE_1_DEV.BRANCH_TYPE",
    ]));
  it("never matches non-source nodes even if their name would glob-match", () =>
    expect(sq("source:*branch*")).toEqual([]));
  it("isolates a different source group", () =>
    expect(sq("source:*_2*")).toEqual(["source.p.SALESFORCE_2_PROD.ACCOUNT"]));
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

describe("bare-token glob wildcards", () => {
  // dbt-style name globbing on bare tokens: * ? [abc] [a-z].
  const gg: Graph = {
    nodes: [
      { id: "stg_orders",  name: "stg_orders",  resource_type: "model", layer: "staging", path: "", description: "" },
      { id: "stg_refunds", name: "stg_refunds", resource_type: "model", layer: "staging", path: "", description: "", materialized: "table" },
      { id: "int_orders",  name: "int_orders",  resource_type: "model", layer: "intermediate", path: "", description: "" },
      { id: "dim_users",   name: "dim_users",   resource_type: "model", layer: "mart", path: "", description: "" },
    ],
    edges: [{ from: "stg_orders", to: "int_orders" }],
  };
  const gids = (q: string) => [...resolveSelector(gg, q)].sort();

  it("* matches a name prefix", () =>
    expect(gids("stg_*")).toEqual(["stg_orders", "stg_refunds"]));
  it("* matches a name suffix", () =>
    expect(gids("*orders")).toEqual(["int_orders", "stg_orders"]));
  it("* matches anywhere", () =>
    expect(gids("*_*")).toEqual(["dim_users", "int_orders", "stg_orders", "stg_refunds"]));
  it("? matches a single character", () =>
    expect(gids("stg_order?")).toEqual(["stg_orders"]));
  it("[..] matches a character set", () =>
    expect(gids("[sd]*")).toEqual(["dim_users", "stg_orders", "stg_refunds"]));
  it("an exact (wildcard-free) name still matches exactly", () =>
    expect(gids("stg_orders")).toEqual(["stg_orders"]));
  it("a glob that matches nothing returns empty", () =>
    expect(gids("xyz_*")).toEqual([]));
  it("intersects a name glob with a method (the stg_ + table case)", () =>
    expect(gids("stg_*,config.materialized:table")).toEqual(["stg_refunds"]));
  it("composes with hops", () =>
    expect(gids("stg_*+")).toEqual(["int_orders", "stg_orders", "stg_refunds"]));
  it("composes with --exclude", () =>
    expect(gids("stg_* --exclude *refunds")).toEqual(["stg_orders"]));
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

describe("hasStateSelector", () => {
  it("detects a bare state term", () => {
    expect(hasStateSelector("state:modified")).toBe(true);
  });
  it("detects state with hop operators", () => {
    expect(hasStateSelector("state:modified+")).toBe(true);
    expect(hasStateSelector("+state:modified")).toBe(true);
    expect(hasStateSelector("2+state:modified+3")).toBe(true);
  });
  it("detects state inside a union or comma-intersection", () => {
    expect(hasStateSelector("tag:mart state:new")).toBe(true);
    expect(hasStateSelector("state:modified,tag:mart")).toBe(true);
  });
  it("detects the dotted state sub-methods", () => {
    expect(hasStateSelector("state:modified.body")).toBe(true);
  });
  it("is false when no state term is present", () => {
    expect(hasStateSelector("tag:mart+")).toBe(false);
    expect(hasStateSelector("my_model")).toBe(false);
    expect(hasStateSelector("")).toBe(false);
  });
  it("does not match a model literally named to contain state", () => {
    expect(hasStateSelector("stg_state_registry")).toBe(false);
    expect(hasStateSelector("upstream:foo")).toBe(false);
  });
});

describe("unused:snapshot", () => {
  // sn1 is a leaf snapshot; sn2 feeds a model; leaf models/seeds must not be
  // classified as unused snapshots merely because they have no children.
  const gsn: Graph = {
    nodes: [
      { id: "sn1", name: "orphan_snapshot", resource_type: "snapshot", layer: "snapshot", path: "snapshots/orphan_snapshot.sql", description: "" },
      { id: "sn2", name: "used_snapshot",   resource_type: "snapshot", layer: "snapshot", path: "snapshots/used_snapshot.sql",   description: "" },
      { id: "m",   name: "stg_from_snapshot", resource_type: "model", layer: "staging", path: "models/staging/stg_from_snapshot.sql", description: "" },
      { id: "sd",  name: "leaf_seed", resource_type: "seed", layer: "model", path: "seeds/leaf_seed.csv", description: "" },
    ],
    edges: [{ from: "sn2", to: "m" }],
  };
  const snids = (q: string) => [...resolveSelector(gsn, q)].sort();

  it("matches snapshots with no downstream consumers", () =>
    expect(snids("unused:snapshot")).toEqual(["sn1"]));
  it("accepts the plural unused:snapshots alias", () =>
    expect(snids("unused:snapshots")).toEqual(["sn1"]));
  it("does NOT match a snapshot that has a downstream consumer", () =>
    expect(snids("unused:snapshot")).not.toContain("sn2"));
  it("does NOT include other leaf resource types", () => {
    expect(snids("unused:snapshot")).not.toContain("m");
    expect(snids("unused:snapshot")).not.toContain("sd");
  });
  it("--exclude unused:snapshot subtracts the unused snapshot set", () =>
    expect(snids("orphan_snapshot used_snapshot stg_from_snapshot --exclude unused:snapshot"))
      .toEqual(["m", "sn2"]));
});
