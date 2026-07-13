# Namespace Extension Meta Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the extension's own model-meta keys (`gist`, `callout`, `subject_areas`, `labels`) from flat `config.meta.<key>` to namespaced `config.meta.dbt_open_lineage.<key>` in `packages/core`, so this extension's data never collides with other tooling writing into the same model's `meta`.

**Architecture:** `yamlEdit.ts`'s `upsertModelDoc` writes only to the nested shape going forward (with a narrow exception: an explicit clear/remove of a legacy-only value also deletes the legacy key, so clearing actually clears). A new `readMeta()` helper in `meta.ts` reads the nested key first, falling back to the old flat key, so already-existing production data keeps rendering with zero manual migration. Four read call sites (`zones.ts`, `CalloutOverlay.tsx`, `App.tsx` x2) switch from raw property access to `readMeta()`.

**Tech Stack:** TypeScript, the `yaml` package (eemeli/yaml) for live-document YAML editing, Vitest + `@testing-library/react` for tests.

## Global Constraints

- Every write in `yamlEdit.ts` targets `config.meta.dbt_open_lineage.<key>` — never a bare `config.meta.<key>` — for `gist`, `callout`, `subject_areas`, `labels`.
- `config.tags` (dbt-native) is never touched by this change — no namespace, no legacy fallback concern.
- `lineage.yml` / `annotations.ts` (project-level style sidecar) is out of scope — not touched by any task.
- Reads (`readMeta`) always prefer the nested value; fall back to the legacy flat key only when the nested key is absent.
- Writes never delete a legacy key on an add/update — only on an explicit clear/remove (gist set to `""`, callout set to `null`/`""`, subject_areas/labels set to `[]`) of a value that currently exists ONLY at the legacy location.
- `doc.toString({ lineWidth: 0 })` stays on every serialization call (disables line-folding — see existing comment in `yamlEdit.ts`).

---

### Task 1: `yamlEdit.ts` — namespace all writes under `dbt_open_lineage`

**Files:**
- Modify: `packages/core/src/yamlEdit.ts`
- Test: `packages/core/src/yamlEdit.test.ts`

**Interfaces:**
- Consumes: nothing new — `yaml` package's `parseDocument`, `isSeq`, `isMap` (already imported).
- Produces: `upsertModelDoc(existingText, name, description, gist, callout?, subjectAreas?, labels?, tags?): string` — same signature as before, unchanged. `targetYamlPath` — unchanged, not touched by this task. Later tasks (`meta.ts`) do not call anything from this file; they only need to know the YAML shape this task produces (`config.meta.dbt_open_lineage.{gist,callout,subject_areas,labels}`).

- [ ] **Step 1: Replace the test file with the updated assertions (still targeting the OLD source, so these fail)**

Write the complete file `packages/core/src/yamlEdit.test.ts`:

```ts
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
    const out = upsertModelDoc(src, "stg_orders", "new desc", "rolls up raw orders");
    expect(out).toContain("# the orders staging model");
    const doc = parse(out);
    expect(doc.models[0].description).toBe("new desc");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("rolls up raw orders");
  });

  it("writes a fresh file in BLOCK style, not flow (no curly braces / inline arrays)", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", undefined, ["orders"], undefined, ["nightly"]);
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
    const out = upsertModelDoc(src, "stg_orders", "d", "g");
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
    const out = upsertModelDoc(src, "stg_orders", "d", "g");
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
    const out = upsertModelDoc(src, "stg_orders", "d", "add a gist");
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
    const doc = parse(upsertModelDoc(src, "dim_account", "new", "the gist"));
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
    const out = upsertModelDoc(src, "dim_account", "an account dimension", "one gist");
    const lines = out.split("\n");
    const di = lines.findIndex((l) => l.includes("description:"));
    const ci = lines.findIndex((l) => l.trimStart().startsWith("config:"));
    const coli = lines.findIndex((l) => l.trimStart().startsWith("columns:"));
    expect(ci).toBeGreaterThan(di);   // config after description
    expect(ci).toBeLessThan(coli);    // and before columns
  });

  it("creates a fresh doc when there is no file yet", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g"));
    expect(doc.version).toBe(2);
    expect(doc.models[0].name).toBe("stg_orders");
    expect(doc.models[0].description).toBe("d");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g");
  });

  it("sets the namespaced callout when a placement string is passed", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", "top"));
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", null));
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", ""));
    expect(doc.models[0].config.meta.callout).toBeUndefined();
  });

  it("tolerates removing callout when none exists", () => {
    const doc = parse(upsertModelDoc(null, "stg_orders", "d", "g", null));
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBeUndefined();
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("g");
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist"));
    // Omitted (not cleared) — legacy value is left fully untouched, still flat.
    // readMeta's fallback (see meta.ts, Task 2) is what makes this still visible.
    expect(doc.models[0].config.meta.callout).toBe("top");
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("new gist");
  });

  it("sets namespaced subject_areas and labels as YAML sequences", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", undefined, ["billing", "orders"], ["core"]);
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "g", undefined, ["orders"], ["core", "pii"]));
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
    const out = upsertModelDoc(src, "stg_orders", "d", "g", undefined, [], ["core"]);
    const doc = parse(out);
    expect(doc.models[0].config.meta.subject_areas).toBeUndefined();               // legacy deleted
    expect(doc.models[0].config.meta.dbt_open_lineage?.subject_areas).toBeUndefined(); // never created
    expect(out).not.toContain("subject_areas");
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core"]); // the other list kept
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist"));
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", "new gist", "top", ["billing"], ["core"]));
    expect(doc.models[0].config.meta.dbt_open_lineage.gist).toBe("new gist");
    expect(doc.models[0].config.meta.dbt_open_lineage.callout).toBe("top");
    expect(doc.models[0].config.meta.dbt_open_lineage.subject_areas).toEqual(["billing"]);
    expect(doc.models[0].config.meta.dbt_open_lineage.labels).toEqual(["core"]);
  });

  it("writes tags to config.tags (dbt-native, not under meta, never namespaced)", () => {
    const out = upsertModelDoc(null, "stg_orders", "d", "g", undefined, undefined, undefined, ["nightly", "core"]);
    const doc = parse(out);
    expect(doc.models[0].config.tags).toEqual(["nightly", "core"]);
    expect(doc.models[0].config.meta?.tags).toBeUndefined(); // NOT under meta
    expect(out).not.toContain('["nightly"'); // a real sequence, not an inline literal
  });

  it("does not seed an empty gist onto a model that never had one", () => {
    // Only a subject-area change; gist is "" and there was no gist before.
    const out = upsertModelDoc(null, "stg_orders", "d", "", undefined, ["orders"]);
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
    const doc = parse(upsertModelDoc(src, "stg_orders", "d", ""));
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
    expect(parse(upsertModelDoc(src, "stg_orders", "d", "g")).models[0].config.tags).toEqual(["nightly"]);
    // [] → key removed
    const out = upsertModelDoc(src, "stg_orders", "d", "g", undefined, undefined, undefined, []);
    expect(parse(out).models[0].config.tags).toBeUndefined();
    expect(out).not.toContain("tags:");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail against the current (un-namespaced) source**

Run: `cd packages/core && npx vitest run src/yamlEdit.test.ts`
Expected: several FAIL — assertions like `doc.models[0].config.meta.dbt_open_lineage.gist` throw (`dbt_open_lineage` is `undefined`) because the current source still writes flat `config.meta.gist`.

- [ ] **Step 3: Replace the implementation**

Write the complete file `packages/core/src/yamlEdit.ts`:

```ts
import { parseDocument, isSeq, isMap, type Document, type YAMLSeq, type YAMLMap } from "yaml";

/** String form of a YAML map key (Scalar node or plain value). */
function keyOf(pair: { key?: unknown }): unknown {
  const k = pair.key as { value?: unknown } | string | undefined;
  return k && typeof k === "object" ? k.value : k;
}

/** The project-relative YAML file that holds (or will hold) this model's
 * description/meta. Prefers the manifest's patch_path; otherwise a per-model
 * sidecar `<name>.yml` sitting right next to the model in its own folder. */
export function targetYamlPath(node: { name: string; path: string; patch_path?: string }): string {
  if (node.patch_path) return node.patch_path;
  const slash = node.path.lastIndexOf("/");
  const dir = slash >= 0 ? node.path.slice(0, slash) : "";
  return dir ? `${dir}/${node.name}.yml` : `${node.name}.yml`;
}

/** Upsert `description` + `config.meta.dbt_open_lineage.gist` for `name`,
 * preserving comments and formatting of `existingText`. An existing `config:`
 * block is kept intact (only the relevant leaves are set inside it); a
 * newly-created `config:` is positioned right under `description`. Seeds a
 * fresh `version: 2` doc when the file does not exist yet. Returns serialized
 * YAML.
 *
 * Every key this extension owns (`gist`, `callout`, `subject_areas`,
 * `labels`) is namespaced under `config.meta.dbt_open_lineage` to avoid
 * colliding with other tools that also write into a model's `meta` — this
 * function ONLY ever writes to the nested shape. Models edited before this
 * namespacing existed may still have these keys flat at `config.meta.<key>`;
 * that legacy data is left untouched here on an add/update (the read side,
 * see meta.ts's readMeta, falls back to it), EXCEPT when a write is an
 * EXPLICIT clear/remove of a key that currently only exists at the legacy
 * location — then the legacy key is deleted too, so clearing something
 * actually clears it instead of leaving a stale value for readMeta's
 * fallback to keep surfacing.
 *
 * `callout` controls `config.meta.dbt_open_lineage.callout` (the placement
 * that makes a gist render as a bubble on the DAG):
 *   - `undefined` → leave any existing callout untouched (default).
 *   - a non-empty string → set it (e.g. "top").
 *   - `null` or `""` → remove it.
 *
 * `subjectAreas` / `labels` control `config.meta.dbt_open_lineage.subject_areas`
 * / `...labels` (a model's membership in named zones / label stripes), and
 * `tags` controls `config.tags` (dbt's native tag list, never namespaced —
 * it was never under `meta` to begin with). Each follows the same convention
 * as `callout`:
 *   - `undefined` → leave any existing list untouched (default).
 *   - a non-empty `string[]` → set it as a YAML sequence.
 *   - an empty `[]` → remove the key (never writes `subject_areas: []`). */
export function upsertModelDoc(
  existingText: string | null, name: string, description: string, gist: string,
  callout?: string | null, subjectAreas?: string[], labels?: string[], tags?: string[],
): string {
  const base = existingText && existingText.trim() ? existingText : "version: 2\nmodels: []\n";
  const doc: Document.Parsed = parseDocument(base);

  let models = doc.get("models");
  if (!isSeq(models)) { doc.set("models", []); models = doc.get("models"); }
  const seq = models as YAMLSeq;
  // Force BLOCK style on the models sequence. The fresh-file seed `models: []`
  // is a FLOW seq, and anything added to a flow collection inherits flow —
  // producing `models: [ { name: x, config: { ... } } ]`. Existing block files
  // already have flow=false here, so this is a no-op for them (no reformatting).
  seq.flow = false;

  let idx = seq.items.findIndex((item) => {
    const m = item as { get?: (k: string) => unknown };
    return typeof m?.get === "function" && m.get("name") === name;
  });
  if (idx === -1) {
    // Add a real YAML node (not a plain JS object) so the seq stays a
    // collection of nodes and sibling entries/comments are untouched.
    seq.add(doc.createNode({ name }));
    idx = seq.items.length - 1;
  }

  const model = seq.get(idx, true) as unknown as YAMLMap;
  const hadConfig = model.has("config");
  // Live-node mutation preserves comments/formatting on everything untouched.
  model.set("description", description);

  const nsPath = (key: string) => ["models", idx, "config", "meta", "dbt_open_lineage", key];
  const legacyPath = (key: string) => ["models", idx, "config", "meta", key];

  // gist: write the nested value whenever it has content, or whenever an
  // existing gist (nested OR legacy) is being updated/cleared — this avoids
  // seeding `gist: ""` onto models that never had one (spurious diff). On an
  // explicit clear (gist === "") of a legacy-only value, the legacy key is
  // also deleted so the clear actually takes effect.
  const gistPath = nsPath("gist");
  const legacyGistPath = legacyPath("gist");
  if (gist !== "" || doc.hasIn(gistPath) || doc.hasIn(legacyGistPath)) doc.setIn(gistPath, gist);
  if (gist === "" && doc.hasIn(legacyGistPath)) doc.deleteIn(legacyGistPath);

  // callout placement: set when a non-empty string, delete on null/"", and
  // leave untouched when omitted (undefined) so 4-arg callers don't disturb
  // it. On explicit removal, delete from wherever the value currently is:
  // the nested key if present, else the legacy flat key.
  if (typeof callout === "string" && callout) {
    doc.setIn(nsPath("callout"), callout);
  } else if (callout === null || callout === "") {
    if (doc.hasIn(nsPath("callout"))) doc.deleteIn(nsPath("callout"));
    else if (doc.hasIn(legacyPath("callout"))) doc.deleteIn(legacyPath("callout"));
  }

  // subject_areas / labels membership lists: same convention as callout. A
  // non-empty array is written as a proper YAML sequence (createNode so it
  // serializes as a list, not an inline JS array), always to the nested path;
  // an empty array removes the key from wherever it lives (nested, else
  // legacy) so we never persist `subject_areas: []`; undefined leaves both
  // locations untouched.
  const setNsList = (key: string, arr: string[] | undefined) => {
    if (arr === undefined) return;
    if (arr.length) { doc.setIn(nsPath(key), doc.createNode(arr)); return; }
    if (doc.hasIn(nsPath(key))) doc.deleteIn(nsPath(key));
    else if (doc.hasIn(legacyPath(key))) doc.deleteIn(legacyPath(key));
  };
  setNsList("subject_areas", subjectAreas);
  setNsList("labels", labels);

  // Tags are dbt-native: they live at config.tags, not under meta, and were
  // never namespaced — no legacy shape to fall back to or migrate away from.
  if (tags !== undefined) {
    const tagsPath = ["models", idx, "config", "tags"];
    if (tags.length) doc.setIn(tagsPath, doc.createNode(tags));
    else if (doc.hasIn(tagsPath)) doc.deleteIn(tagsPath);
  }

  // A config block we just created lands at the end of the map; move it right
  // under `description` (or `name`) so it reads where dbt authors expect it.
  if (!hadConfig && isMap(model)) {
    const items = model.items as Array<{ key?: unknown }>;
    const ci = items.findIndex((p) => keyOf(p) === "config");
    if (ci >= 0) {
      const [pair] = items.splice(ci, 1);
      let anchor = items.findIndex((p) => keyOf(p) === "description");
      if (anchor < 0) anchor = items.findIndex((p) => keyOf(p) === "name");
      items.splice(anchor + 1, 0, pair);
    }
  }

  // lineWidth: 0 disables line folding — otherwise toString() re-wraps every
  // long scalar in the file to 80 cols, producing spurious diffs on column
  // descriptions we never touched.
  return doc.toString({ lineWidth: 0 });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/yamlEdit.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run the full core test suite to catch any other consumer of the old flat shape**

Run: `cd packages/core && npx vitest run`
Expected: any pre-existing failures here are consumers of the old flat shape that Tasks 2-5 haven't fixed yet — that's expected at this point in the plan. Confirm the ONLY new failures are in `App.test.tsx`, `zones.test.ts`, or wherever `CalloutOverlay`/`zones`/`App` read `config.meta.<key>` directly (these get fixed in Tasks 2-5). If a failure appears anywhere else, stop and investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/yamlEdit.ts packages/core/src/yamlEdit.test.ts
git commit -m "$(cat <<'EOF'
feat(core): namespace model-meta writes under dbt_open_lineage

gist/callout/subject_areas/labels now write to
config.meta.dbt_open_lineage.<key> instead of flat config.meta.<key>,
avoiding collisions with other tools writing into the same model's
meta. Explicit clear/remove of a legacy-only value also deletes the
legacy key so clearing actually clears; other adds/updates leave
legacy data untouched (read-side fallback in meta.ts, Task 2, covers
it going forward).
EOF
)"
```

---

### Task 2: `meta.ts` — `readMeta()` nested-then-legacy-fallback helper

**Files:**
- Create: `packages/core/src/meta.ts`
- Test: `packages/core/src/meta.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no imports beyond built-ins).
- Produces: `readMeta(meta: Record<string, unknown> | undefined, key: string): unknown` — Tasks 3, 4, 5 import this from `./meta`.

- [ ] **Step 1: Write the failing test**

Write the complete file `packages/core/src/meta.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/meta.test.ts`
Expected: FAIL — `Failed to resolve import "./meta"` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Write the complete file `packages/core/src/meta.ts`:

```ts
/** Read one of this extension's own keys (`gist`, `callout`, `subject_areas`,
 * `labels`) off a compiled node's `meta`. Prefers the namespaced
 * `meta.dbt_open_lineage.<key>` shape (see yamlEdit.ts's upsertModelDoc,
 * which only ever writes there); falls back to the pre-namespace flat
 * `meta.<key>` for models not yet re-saved through this extension. `key`
 * presence (not truthiness) decides which side wins, so an explicit nested
 * `""` still beats a non-empty legacy value. */
export function readMeta(meta: Record<string, unknown> | undefined, key: string): unknown {
  const ns = meta?.dbt_open_lineage as Record<string, unknown> | undefined;
  if (ns && key in ns) return ns[key];
  return meta?.[key];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/meta.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/meta.ts packages/core/src/meta.test.ts
git commit -m "feat(core): add readMeta() nested-then-legacy fallback helper"
```

---

### Task 3: `zones.ts` — `nodeAreas`/`nodeLabels` use `readMeta`

**Files:**
- Modify: `packages/core/src/zones.ts:6-18`
- Test: `packages/core/src/zones.test.ts:1-28`

**Interfaces:**
- Consumes: `readMeta(meta, key): unknown` from `./meta` (Task 2).
- Produces: `nodeAreas`/`nodeLabels` signatures unchanged (`(node: { meta?: Record<string, unknown> }) => string[]`) — App.tsx (Task 5) already calls these and needs no changes on their account.

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/zones.test.ts`, replace lines 1-28 (the `nodeAreas`/`nodeLabels` describe blocks; everything from `areaMembers` onward, line 29+, is unchanged) with:

```ts
import { describe, it, expect } from "vitest";
import {
  nodeAreas, areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt,
} from "./zones";
import { nodeLabels } from "./zones";

describe("nodeAreas", () => {
  it("returns the string list from the namespaced meta.dbt_open_lineage.subject_areas", () => {
    expect(nodeAreas({ meta: { dbt_open_lineage: { subject_areas: ["a", "b"] } } })).toEqual(["a", "b"]);
  });
  it("falls back to legacy flat meta.subject_areas when the namespaced key is absent", () => {
    expect(nodeAreas({ meta: { subject_areas: ["a", "b"] } })).toEqual(["a", "b"]);
  });
  it("returns [] when absent, non-array, or non-string entries", () => {
    expect(nodeAreas({})).toEqual([]);
    expect(nodeAreas({ meta: {} })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: "a" } })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: ["a", 3] } })).toEqual(["a"]);
  });
});

describe("nodeLabels", () => {
  it("returns the string list from the namespaced meta.dbt_open_lineage.labels", () => {
    expect(nodeLabels({ meta: { dbt_open_lineage: { labels: ["core", "revenue"] } } }))
      .toEqual(["core", "revenue"]);
  });
  it("falls back to legacy flat meta.labels when the namespaced key is absent", () => {
    expect(nodeLabels({ meta: { labels: ["core", "revenue"] } })).toEqual(["core", "revenue"]);
  });
  it("returns [] when absent / non-array / non-string entries", () => {
    expect(nodeLabels({})).toEqual([]);
    expect(nodeLabels({ meta: { labels: "core" } })).toEqual([]);
    expect(nodeLabels({ meta: { labels: ["core", 7] } })).toEqual(["core"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/zones.test.ts`
Expected: the two new fallback tests FAIL (nested-shape lookup returns `[]` because the current source still reads flat `meta.subject_areas`/`meta.labels` directly, which coincidentally makes the FIRST two new tests pass by accident via the flat read — but rename makes intent explicit); rerun mentally: current source reads `node.meta?.subject_areas` directly, so the "namespaced" test (data only at `meta.dbt_open_lineage.subject_areas`) FAILS (returns `[]`, expected `["a","b"]`). The "legacy fallback" test passes already (it's testing the CURRENT behavior). Confirm exactly one new failure per describe block before continuing.

- [ ] **Step 3: Update the implementation**

In `packages/core/src/zones.ts`, add the import and replace lines 6-18:

```ts
import { NODE_W, NODE_H } from "./layout";
import { readMeta } from "./meta";

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** The subject areas a node declares, via `meta.dbt_open_lineage.subject_areas`
 * (falling back to the legacy flat `meta.subject_areas` — see readMeta).
 * Tolerant of a missing/mistyped value: always returns a string[]. */
export function nodeAreas(node: { meta?: Record<string, unknown> }): string[] {
  const v = readMeta(node.meta, "subject_areas");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The labels a node declares, via `meta.dbt_open_lineage.labels` (falling
 * back to the legacy flat `meta.labels` — see readMeta). Tolerant of a
 * missing/mistyped value: always returns a string[]. */
export function nodeLabels(node: { meta?: Record<string, unknown> }): string[] {
  const v = readMeta(node.meta, "labels");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
```

Leave everything from `areaMembers` (originally line 20) onward in the file completely unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/zones.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/zones.ts packages/core/src/zones.test.ts
git commit -m "feat(core): zones.ts reads subject_areas/labels via readMeta"
```

---

### Task 4: `CalloutOverlay.tsx` — `gistOf` uses `readMeta`, gains a test file

**Files:**
- Modify: `packages/core/src/CalloutOverlay.tsx:43-48`
- Create: `packages/core/src/CalloutOverlay.test.ts` (new — this file currently has no test coverage)

**Interfaces:**
- Consumes: `readMeta(meta, key): unknown` from `./meta` (Task 2).
- Produces: `gistOf` becomes exported (was private) so it's directly testable; signature unchanged (`(node: { meta?: Record<string, unknown> }) => string | null`).

- [ ] **Step 1: Write the failing test**

Write the complete file `packages/core/src/CalloutOverlay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gistOf } from "./CalloutOverlay";

describe("gistOf", () => {
  it("returns the trimmed gist when namespaced gist + callout are both present", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "  hello  ", callout: "top" } } })).toBe("hello");
  });

  it("falls back to legacy flat gist/callout when the namespaced keys are absent", () => {
    expect(gistOf({ meta: { gist: "legacy gist", callout: "top" } })).toBe("legacy gist");
  });

  it("returns null when gist is present but there is no callout placement", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "hello" } } })).toBeNull();
  });

  it("returns null when callout is present but gist is empty/whitespace-only", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "   ", callout: "top" } } })).toBeNull();
  });

  it("returns null when meta is absent entirely", () => {
    expect(gistOf({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.ts`
Expected: FAIL — `gistOf` is not exported from `./CalloutOverlay` yet (`SyntaxError` / `undefined is not a function` depending on the runner, since the named import resolves to `undefined`).

- [ ] **Step 3: Update the implementation**

In `packages/core/src/CalloutOverlay.tsx`, add the import and replace lines 43-48:

```tsx
import { useRef } from "react";
import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";
import { NODE_W } from "./layout";
import { readMeta } from "./meta";
```

(only the new `readMeta` import line is added — `useRef`/`ViewportPortal`/`Pt`/`NODE_W` imports stay exactly as they are)

```tsx
/** The model's gist text, or null if there is no gist or no callout
 * placement to anchor it to. Reads via readMeta — namespaced
 * meta.dbt_open_lineage.{gist,callout} first, falling back to the legacy
 * flat meta.{gist,callout}. Exported for direct testing. */
export function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "gist");
  const c = readMeta(node.meta, "callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/CalloutOverlay.tsx packages/core/src/CalloutOverlay.test.ts
git commit -m "feat(core): CalloutOverlay reads gist/callout via readMeta"
```

---

### Task 5: `App.tsx` — 4 gist/callout draft-population sites use `readMeta`

**Files:**
- Modify: `packages/core/src/App.tsx:1-21` (import), `:547-548`, `:1256-1257`
- Test: `packages/core/src/App.test.tsx` (add one new test to the existing `"editable description + gist panel"` describe block, which starts at line 314)

**Interfaces:**
- Consumes: `readMeta(meta, key): unknown` from `./meta` (Task 2).
- Produces: nothing new consumed by later code — this is the last task.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/App.test.tsx`, inside the existing `describe("editable description + gist panel", ...)` block (starts at line 314, after the `beforeEach` at line 315), add a new `it` block right after the closing brace of the `"sparkle fills the gist field..."` test (originally ending at line 341, right before the block's closing `});` at line 342):

```tsx
  it("populates the gist field from a legacy flat meta.gist (pre-namespace data)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { gist: "flat legacy gist", callout: "top" },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("flat legacy gist"));
  });
```

This exercises the `useEffect` at (current) lines 545-551, which is the code path Step 3 changes. Note: this test intentionally overwrites `manifestGraph` with its own fixture (containing a `meta` field the shared `oneModelGraph` fixture does not have) rather than adding `meta` to `oneModelGraph` itself, so the other tests in this file that rely on `oneModelGraph` having no pre-set meta are undisturbed.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/App.test.tsx -t "legacy flat meta.gist"`
Expected: FAIL — the gist textarea's value is `""`, not `"flat legacy gist"`, because the current source only reads `node.meta?.gist` directly and this test's `GraphNode` type may need `meta` accepted; if TypeScript complains `meta` is not assignable, that confirms `GraphNode` already declares `meta?: Record<string, unknown>` (it does, per `graphTypes.ts:11`) — the test should compile fine and fail only on the assertion.

- [ ] **Step 3: Update the implementation**

In `packages/core/src/App.tsx`, add the import — insert it as a new line right after the existing `import { nodeAreas, nodeLabels } from "./zones";` (currently line 17):

```tsx
import { nodeAreas, nodeLabels } from "./zones";
import { readMeta } from "./meta";
```

Replace the two lines at (current) 547-548:

```tsx
    setGistDraft(typeof readMeta(selectedNode?.meta, "gist") === "string" ? (readMeta(selectedNode?.meta, "gist") as string) : "");
    setCalloutDraft(!!readMeta(selectedNode?.meta, "callout"));
```

Replace the two lines at (current) 1256-1257:

```tsx
                      setGistDraft(typeof readMeta(selectedNode.meta, "gist") === "string" ? (readMeta(selectedNode.meta, "gist") as string) : "");
                      setCalloutDraft(!!readMeta(selectedNode.meta, "callout"));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/App.test.tsx`
Expected: all tests PASS, including the new one.

- [ ] **Step 5: Run the full core test suite**

Run: `cd packages/core && npx vitest run`
Expected: all tests PASS (this is the last task — no more read sites should reference the old flat shape directly).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): App.tsx gist/callout drafts read via readMeta"
```

---

### Task 6: Rebuild, repackage, bump versions

**Files:**
- Modify: `packages/core/package.json` (version bump)
- Modify: `packages/mext/package.json` (version bump)
- Modify: `packages/vscode/package.json` (version bump)

**Interfaces:**
- Consumes: the finished `packages/core` from Tasks 1-5 (no code changes in this task, only version numbers + rebuilt artifacts).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Run the full workspace test suite**

Run: `npm run test --workspaces --if-present` (from repo root)
Expected: `core`, `mext`, and `vscode` test suites all PASS.

- [ ] **Step 2: Bump all three package versions by one patch each**

Read the current versions from `packages/core/package.json`, `packages/mext/package.json`, `packages/vscode/package.json` (each has a top-level `"version"` field) and bump each by one patch (e.g. `0.2.21` → `0.2.22`). This repo's convention bumps all three in lockstep on every release, regardless of which package actually changed — see recent `git log` for the pattern (`chore: bump to mext X / core X / vscode X`).

- [ ] **Step 3: Rebuild all artifacts**

Run: `npm run rebuild` (from repo root)
Expected: completes with no errors; produces `packages/mext/dbt-dag-viz.mext` and `packages/vscode/dbt-open-lineage-<new-version>.vsix`.

- [ ] **Step 4: Commit the version bump**

```bash
git add packages/core/package.json packages/mext/package.json packages/vscode/package.json
git commit -m "chore: bump to mext <new-mext-version> / core <new-core-version> / vscode <new-vscode-version>"
```
