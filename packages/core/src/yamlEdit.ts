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

/** Upsert `description` + `config.meta.dbt_open_lineage.gist`/`grain` for
 * `name`, preserving comments and formatting of `existingText`. An existing
 * `config:` block is kept intact (only the relevant leaves are set inside
 * it); a newly-created `config:` is positioned right under `description`.
 * Seeds a fresh `version: 2` doc when the file does not exist yet. Returns
 * serialized YAML.
 *
 * Every key this extension owns (`gist`, `grain`, `callout`, `grain_callout`,
 * `subject_areas`, `labels`) is namespaced under `config.meta.dbt_open_lineage` to avoid
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
 * `grain` follows the exact same convention as `gist` (see below) — a
 * required free-text scalar describing the model's grain.
 *
 * `callout` controls `config.meta.dbt_open_lineage.callout` (the placement
 * that makes a gist render as a bubble on the DAG):
 *   - `undefined` → leave any existing callout untouched (default).
 *   - a non-empty string → set it (e.g. "top").
 *   - `null` or `""` → remove it.
 *
 * `grain_callout` controls `config.meta.dbt_open_lineage.grain_callout` (the
 * placement that makes `grain` render as a second bubble on the DAG),
 * following the exact same convention as `callout` above.
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
  grain: string, callout?: string | null, grainCallout?: string | null,
  subjectAreas?: string[], labels?: string[], tags?: string[],
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
  // Delete `key` from BOTH the nested and legacy locations, whichever are
  // present. A normal scenario leaves both populated at once: a pre-namespace
  // model has a legacy value; the user re-saves once with it still set, which
  // writes the nested key WITHOUT deleting the legacy one (see the
  // add/update comment above) — so both now exist. An `else if` here would
  // only ever delete one side, and the other resurfaces via readMeta's
  // legacy fallback — the value could never actually be removed.
  const clearOwnedKey = (key: string) => {
    const np = nsPath(key), lp = legacyPath(key);
    if (doc.hasIn(np)) doc.deleteIn(np);
    if (doc.hasIn(lp)) doc.deleteIn(lp);
  };

  // gist: write the nested value whenever it has content, or whenever an
  // existing gist (nested OR legacy) is being updated/cleared — this avoids
  // seeding `gist: ""` onto models that never had one (spurious diff). On an
  // explicit clear (gist === "") of a legacy-only value, the legacy key is
  // also deleted so the clear actually takes effect.
  const gistPath = nsPath("gist");
  const legacyGistPath = legacyPath("gist");
  if (gist !== "" || doc.hasIn(gistPath) || doc.hasIn(legacyGistPath)) doc.setIn(gistPath, gist);
  if (gist === "" && doc.hasIn(legacyGistPath)) doc.deleteIn(legacyGistPath);

  // grain: identical treatment to gist, same reasoning.
  const grainPath = nsPath("grain");
  const legacyGrainPath = legacyPath("grain");
  if (grain !== "" || doc.hasIn(grainPath) || doc.hasIn(legacyGrainPath)) doc.setIn(grainPath, grain);
  if (grain === "" && doc.hasIn(legacyGrainPath)) doc.deleteIn(legacyGrainPath);

  // callout placement: set when a non-empty string, delete on null/"", and
  // leave untouched when omitted (undefined) so callers that don't pass it
  // don't disturb it. On explicit removal, delete from wherever the value
  // currently is: the nested key if present, else the legacy flat key.
  if (typeof callout === "string" && callout) {
    doc.setIn(nsPath("callout"), callout);
  } else if (callout === null || callout === "") {
    clearOwnedKey("callout");
  }

  // grain_callout placement: identical treatment to callout, same reasoning.
  if (typeof grainCallout === "string" && grainCallout) {
    doc.setIn(nsPath("grain_callout"), grainCallout);
  } else if (grainCallout === null || grainCallout === "") {
    clearOwnedKey("grain_callout");
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
    clearOwnedKey(key);
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
