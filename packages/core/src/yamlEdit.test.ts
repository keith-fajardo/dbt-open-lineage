import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { targetYamlPath, upsertModelDoc } from "./yamlEdit";

describe("targetYamlPath", () => {
  it("uses patch_path when present", () => {
    expect(targetYamlPath({ name: "stg_orders", path: "models/staging/stg_orders.sql", patch_path: "models/staging/_stg__models.yml" }))
      .toBe("models/staging/_stg__models.yml");
  });
  it("falls back to a <name>.yml sidecar next to the model (no leading underscore)", () => {
    expect(targetYamlPath({ name: "stg_orders", path: "models/staging/stg_orders.sql" }))
      .toBe("models/staging/stg_orders.yml");
  });
});

describe("upsertModelDoc", () => {
  it("updates an existing entry and preserves comments", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders  # the orders staging model",
      "    description: old",
    ].join("\n");
    const out = upsertModelDoc(src, "stg_orders", "new desc", "rolls up raw orders", "");
    expect(out).toContain("# the orders staging model");
    const doc = parse(out);
    expect(doc.models[0].description).toBe("new desc");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("rolls up raw orders");
  });

  it("writes a fresh file in BLOCK style, not flow (no curly braces / inline arrays)", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", "", undefined, ["orders"], undefined, ["nightly"]);
    expect(out).not.toContain("{"); // no flow maps
    expect(out).not.toContain("["); // no flow/inline sequences
    expect(out).toContain("  - name: stg_orders");
    expect(out).toContain("    config:");
    expect(out).toContain("      meta:");
    expect(out).toContain("        dbt_open_lineage:");
    // sanity: still parses to the right shape
    const doc = parse(out);
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["orders"]);
    expect(doc.models[0].config.tags).toEqual(["nightly"]);
  });

  it("appends a model absent from an existing file", () => {
    const src = "version: 2\nmodels:\n  - name: other\n    description: keep\n";
    const out = upsertModelDoc(src, "stg_orders", "d", "g", "");
    const doc = parse(out);
    expect(doc.models.map((m: { name: string }) => m.name)).toEqual(["other", "stg_orders"]);
    expect(doc.models[0].description).toBe("keep");
    expect(doc.models[1].config.meta.dbt_open_lineage.gist).toBe("g");
  });

  it("preserves a comment on a pre-existing sibling entry when appending a new model", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: other  # do not touch this comment",
      "    description: keep",
    ].join("\n");
    const out = upsertModelDoc(src, "stg_orders", "d", "g", "");
    expect(out).toContain("# do not touch this comment");
    const doc = parse(out);
    expect(doc.models.map((m: { name: string }) => m.name)).toEqual(["other", "stg_orders"]);
    expect(doc.models[0].description).toBe("keep");
    expect(doc.models[1].name).toBe("stg_orders");
    expect(doc.models[1].description).toBe("d");
    expect(doc.models[1].config.meta.dbt_open_lineage.gist).toBe("g");
  });

  it("does not re-wrap long lines it never touched", () => {
    const longDesc =
      "Foreign key to the Salesforce RecordType for this account (e.g. Practice, Group).";
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    columns:",
      "      - name: recordtype_id",
      `        description: ${longDesc}`,
    ].join("\n");
    const out = upsertModelDoc(src, "stg_orders", "d", "add a gist", "");
    // The untouched long column description must stay on ONE line (no folding).
    expect(out).toContain(`description: ${longDesc}`);
  });

  it("preserves an existing config block, adding only the namespaced gist", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: dim_account",
      "    description: old",
      "    config:",
      "      materialized: table",
      "      tags: [daily]",
      "      meta:",
      "        owner: analytics",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "dim_account", "new", "the gist", ""));
    expect(doc.models[0].config.materialized).toBe("table");
    expect(doc.models[0].config.tags).toEqual(["daily"]);
    // A third-party sibling meta key (not one of ours) is untouched, still flat —
    // this is the whole point of namespacing: we never move or read keys we don't own.
    expect(doc.models[0].config.meta.owner).toBe("analytics");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("the gist");
    expect(doc.models[0].description).toBe("new");
  });

  it("places a new config block right under description (above columns)", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: dim_account",
      "    description: an account dimension",
      "    columns:",
      "      - name: id",
    ].join("\n");
    const out = upsertModelDoc(src, "dim_account", "an account dimension", "one gist", "");
    const lines = out.split("\n");
    const di = lines.findIndex((l) => l.includes("description:"));
    const ci = lines.findIndex((l) => l.trimStart().startsWith("config:"));
    const coli = lines.findIndex((l) => l.trimStart().startsWith("columns:"));
    expect(ci).toBeGreaterThan(di);   // config after description
    expect(ci).toBeLessThan(coli);    // and before columns
  });

  it("creates a fresh doc when there is no file yet", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", ""));
    expect(doc.version).toBe(2);
    expect(doc.models[0].name).toBe("stg_orders");
    expect(doc.models[0].description).toBe("d");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g");
  });

  it("sets the namespaced callout when a placement string is passed", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", "", "top"));
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBe("top");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g"); // gist still written
  });

  it("removes a legacy flat callout when null is passed (explicit clear deletes it)", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    description: old",
      "    config:",
      "      meta:",
      "        gist: g",
      "        callout: top",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", "", null));
    expect(doc.models[0].config.meta.callout).toBeUndefined();               // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage?.callout).toBeUndefined(); // never created
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g");       // gist still namespaced-written
  });

  it("removes config.meta.callout when an empty string is passed", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        callout: top",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", "", ""));
    expect(doc.models[0].config.meta.callout).toBeUndefined();
  });

  it("tolerates removing callout when none exists", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", "", null));
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBeUndefined();
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g");
  });

  it("clears a callout present in BOTH nested and legacy locations — both are deleted, not just one", () => {
    // Realistic scenario: a pre-namespace model has a legacy `callout: top`.
    // The user re-saves once with the callout still on — that write sets the
    // nested key without deleting the legacy one (see "leaves an existing
    // legacy callout intact when the arg is omitted" above) — so now BOTH
    // exist. A later explicit clear must remove both, or readMeta's legacy
    // fallback resurrects the value.
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    description: old",
      "    config:",
      "      meta:",
      "        gist: g",
      "        callout: top",
      "        dbt_open_lineage:",
      "          callout: top",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", "", null));
    expect(doc.models[0].config.meta.callout).toBeUndefined();                // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBeUndefined(); // nested deleted
  });

  it("leaves an existing legacy callout intact when the arg is omitted (undefined)", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    description: old",
      "    config:",
      "      meta:",
      "        gist: g",
      "        callout: top",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist", ""));
    // Omitted (not cleared) — legacy value is left fully untouched, still flat.
    // readMeta's fallback (see meta.ts) is what makes this still visible.
    expect(doc.models[0].config.meta.callout).toBe("top");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("new gist");
  });

  it("sets namespaced subject_areas and labels as YAML sequences", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", "", undefined, ["billing", "orders"], ["core"]);
    const doc = parse(out);
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["billing", "orders"]);
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core"]);
    // Serialized as a real sequence, not an inline JS-array literal.
    expect(out).toContain("subject_areas:");
    expect(out).not.toContain('["billing"');
  });

  it("adds namespaced subject_areas/labels alongside untouched legacy ones", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        subject_areas: [billing]",
      "        labels: [core]",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", "", undefined, ["orders"], ["core", "pii"]));
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["orders"]);
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core", "pii"]);
  });

  it("removes a legacy-only list when an empty array is passed (never writes subject_areas: [])", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        subject_areas: [billing]",
      "        labels: [core]",
    ].join("\n");
    const out = upsertModelDoc(src, "stg_orders", "d", "g", "", undefined, [], ["core"]);
    const doc = parse(out);
    expect(doc.models[0].config.meta.subject_areas).toBeUndefined();               // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage?.subject_areas).toBeUndefined(); // never created
    expect(out).not.toContain("subject_areas");
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core"]); // the other list kept
  });

  it("clears a subject_areas list present in BOTH nested and legacy locations — both are deleted", () => {
    // Same both-present scenario as the callout test above, but for a list
    // key going through setNsList.
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        subject_areas: [billing]",
      "        dbt_open_lineage:",
      "          subject_areas: [billing]",
    ].join("\n");
    const out = upsertModelDoc(src, "stg_orders", "d", "g", "", undefined, []);
    const doc = parse(out);
    expect(doc.models[0].config.meta.subject_areas).toBeUndefined();                // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toBeUndefined(); // nested deleted
    expect(out).not.toContain("subject_areas");
  });

  it("leaves existing legacy subject_areas/labels intact when the args are omitted (undefined)", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        subject_areas: [billing, orders]",
      "        labels: [core]",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist", ""));
    expect(doc.models[0].config.meta.subject_areas).toEqual(["billing", "orders"]); // untouched
    expect(doc.models[0].config.meta.labels).toEqual(["core"]); // untouched
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("new gist");
  });

  it("round-trips gist and callout alongside subject_areas and labels, all namespaced", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    description: old",
      "    config:",
      "      meta:",
      "        gist: g",
      "        callout: top",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist", "", "top", ["billing"], ["core"]));
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("new gist");
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBe("top");
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["billing"]);
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core"]);
  });

  it("writes tags to config.tags (dbt-native, not under meta, never namespaced)", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", "", undefined, undefined, undefined, ["nightly", "core"]);
    const doc = parse(out);
    expect(doc.models[0].config.tags).toEqual(["nightly", "core"]);
    expect(doc.models[0].config.meta?.tags).toBeUndefined(); // NOT under meta
    expect(out).not.toContain('["nightly"'); // a real sequence, not an inline literal
  });

  it("does not seed an empty gist onto a model that never had one", () => {
    // Only a subject-area change; gist is "" and there was no gist before.
    const out = upsertModelDoc(null, "stg_orders", "d", "", "", undefined, ["orders"]);
    const doc = parse(out);
    expect(doc.models[0].config.meta.dbt_open_lineage?.gist).toBeUndefined();
    expect(out).not.toContain("gist:");
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["orders"]); // the real change kept
  });

  it("still clears an existing legacy gist when set to empty, deleting the legacy key", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        gist: old",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "", ""));
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe(""); // namespaced key present, emptied
    expect(doc.models[0].config.meta.gist).toBeUndefined();           // legacy key removed — clear took effect
  });

  it("removes config.tags when an empty array is passed, and leaves it untouched when omitted", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      tags: [nightly]",
    ].join("\n");
    // omitted → untouched
    expect(parse(upsertModelDoc(src, "stg_orders", "d", "g", "")).models[0].config.tags).toEqual(["nightly"]);
    // [] → key removed
    const out = upsertModelDoc(src, "stg_orders", "d", "g", "", undefined, undefined, undefined, []);
    expect(parse(out).models[0].config.tags).toBeUndefined();
    expect(out).not.toContain("tags:");
  });

  it("sets the namespaced grain when a value is passed", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", "one row per order_id per day"));
    expect(doc.models[0].config.meta.dbt_open_lineage.grain).toBe("one row per order_id per day");
  });

  it("writes grain alongside gist without disturbing either", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "the gist", "one row per order_id"));
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("the gist");
    expect(doc.models[0].config.meta.dbt_open_lineage.grain).toBe("one row per order_id");
  });

  it("does not seed an empty grain onto a model that never had one", () => {
    // Only a subject-area change; grain is "" and there was no grain before.
    const out = upsertModelDoc(null, "stg_orders", "d", "g", "", undefined, ["orders"]);
    const doc = parse(out);
    expect(doc.models[0].config.meta.dbt_open_lineage?.grain).toBeUndefined();
    expect(out).not.toContain("grain:");
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["orders"]); // the real change kept
  });

  it("still clears an existing legacy grain when set to empty, deleting the legacy key", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        grain: old grain",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", ""));
    expect(doc.models[0].config.meta.dbt_open_lineage.grain).toBe(""); // namespaced key present, emptied
    expect(doc.models[0].config.meta.grain).toBeUndefined();           // legacy key removed — clear took effect
  });

  it("clears a grain present in BOTH nested and legacy locations — both are deleted", () => {
    const src = [
      "version: 2",
      "models:",
      "  - name: stg_orders",
      "    config:",
      "      meta:",
      "        grain: old grain",
      "        dbt_open_lineage:",
      "          grain: old grain",
    ].join("\n");
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", ""));
    expect(doc.models[0].config.meta.grain).toBeUndefined();                 // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage.grain).toBe("");       // nested emptied, not deleted (matches gist)
  });
});
