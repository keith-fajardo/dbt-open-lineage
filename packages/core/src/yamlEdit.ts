import { parseDocument, isSeq, isMap, type Document, type YAMLSeq, type YAMLMap } from "yaml";

/** String form of a YAML map key (Scalar node or plain value). */
function keyOf(pair: { key?: unknown }): unknown {
  const k = pair.key as { value?: unknown } | string | undefined;
  return k && typeof k === "object" ? k.value : k;
}

/** The project-relative YAML file that holds (or will hold) this model's
 * description/meta. Prefers the manifest's patch_path; otherwise a per-model
 * sidecar `_<name>.yml` in the model's own folder. */
export function targetYamlPath(node: { name: string; path: string; patch_path?: string }): string {
  if (node.patch_path) return node.patch_path;
  const slash = node.path.lastIndexOf("/");
  const dir = slash >= 0 ? node.path.slice(0, slash) : "";
  return dir ? `${dir}/_${node.name}.yml` : `_${node.name}.yml`;
}

/** Upsert `description` + `config.meta.gist` for `name`, preserving comments
 * and formatting of `existingText`. An existing `config:` block is kept intact
 * (only `meta.gist` is set inside it); a newly-created `config:` is positioned
 * right under `description`. Seeds a fresh `version: 2` doc when the file does
 * not exist yet. Returns serialized YAML.
 *
 * `callout` controls `config.meta.callout` (the placement that makes a gist
 * render as a bubble on the DAG):
 *   - `undefined` → leave any existing callout untouched (default).
 *   - a non-empty string → set it (e.g. "top").
 *   - `null` or `""` → remove it.
 *
 * `subjectAreas` / `labels` control `config.meta.subject_areas` /
 * `config.meta.labels` (a model's membership in named zones / label stripes).
 * Each follows the same convention as `callout`:
 *   - `undefined` → leave any existing list untouched (default).
 *   - a non-empty `string[]` → set it as a YAML sequence.
 *   - an empty `[]` → remove the key (never writes `subject_areas: []`). */
export function upsertModelDoc(
  existingText: string | null, name: string, description: string, gist: string,
  callout?: string | null, subjectAreas?: string[], labels?: string[],
): string {
  const base = existingText && existingText.trim() ? existingText : "version: 2\nmodels: []\n";
  const doc: Document.Parsed = parseDocument(base);

  let models = doc.get("models");
  if (!isSeq(models)) { doc.set("models", []); models = doc.get("models"); }
  const seq = models as YAMLSeq;

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
  // Existing config is preserved in place — setIn only writes the meta.gist
  // leaf, keeping materialized/tags/other meta keys.
  doc.setIn(["models", idx, "config", "meta", "gist"], gist);
  // callout placement: set when a non-empty string, delete on null/"", and
  // leave untouched when omitted (undefined) so 4-arg callers don't disturb it.
  if (typeof callout === "string" && callout) {
    doc.setIn(["models", idx, "config", "meta", "callout"], callout);
  } else if (callout === null || callout === "") {
    if (doc.hasIn(["models", idx, "config", "meta", "callout"])) {
      doc.deleteIn(["models", idx, "config", "meta", "callout"]);
    }
  }

  // subject_areas / labels membership lists: same convention as callout.
  // A non-empty array is written as a proper YAML sequence (createNode so it
  // serializes as a list, not an inline JS array); an empty array removes the
  // key so we never persist `subject_areas: []`; undefined leaves it untouched.
  const setList = (key: string, arr: string[] | undefined) => {
    if (arr === undefined) return;
    const path = ["models", idx, "config", "meta", key];
    if (arr.length) doc.setIn(path, doc.createNode(arr));
    else if (doc.hasIn(path)) doc.deleteIn(path);
  };
  setList("subject_areas", subjectAreas);
  setList("labels", labels);

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
