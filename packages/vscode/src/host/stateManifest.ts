import * as fs from "fs";
import * as path from "path";

/** The resource types present in the lineage graph and supported by the
 * existing `dbt ls` resolver. Tests, analyses, and macros can influence this
 * result but are not themselves graph nodes. */
const GRAPH_RESOURCE_TYPES = new Set(["model", "snapshot", "seed", "source"]);

type JsonRecord = Record<string, unknown>;

interface StateManifest {
  nodes?: Record<string, JsonRecord>;
  sources?: Record<string, JsonRecord>;
  macros?: Record<string, JsonRecord>;
  child_map?: Record<string, string[]>;
}

export interface LocalStateResolution {
  /** The graph-node ids to display. */
  ids: string[];
  /** Changed resources before `+`/ancestor expansion. Useful diagnostic data. */
  modifiedCount: number;
}

interface StateTerm {
  up: number;
  down: number;
  body: boolean;
}

/**
 * Return a local resolver for state:modified and state:modified.body forms.
 * Other dbt selector methods/subselectors intentionally return undefined so
 * the caller can delegate to dbt, preserving dbt's exact behaviour rather
 * than silently approximating a selector we do not fully implement.
 */
function parseLocalStateTerms(select: string): StateTerm[] | undefined {
  // `--exclude` can contain any dbt selector method, so retain dbt as the
  // authority for that richer grammar for now.
  if (/\s--exclude\b/.test(select)) return undefined;
  const rawTerms = select.trim().split(/\s+/).filter(Boolean);
  if (!rawTerms.length) return undefined;
  const terms: StateTerm[] = [];
  for (const raw of rawTerms) {
    // dbt union is whitespace-delimited; comma intersections and non-state
    // terms are intentionally delegated to dbt because they have more nuanced
    // semantics. Both the full state:modified and body-only subselector can be
    // compared from manifest artifacts locally.
    const m = raw.match(/^(\d*\+)?state:modified(\.body)?(\+\d*)?$/);
    if (!m) return undefined;
    const up = m[1] ? (m[1] === "+" ? Infinity : Number.parseInt(m[1], 10)) : 0;
    const down = m[3] ? (m[3] === "+" ? Infinity : Number.parseInt(m[3].slice(1), 10)) : 0;
    terms.push({ up, down, body: m[2] === ".body" });
  }
  return terms;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function resourceMap(manifest: StateManifest): Record<string, JsonRecord> {
  const out: Record<string, JsonRecord> = {};
  for (const [id, node] of Object.entries(manifest.nodes ?? {})) {
    if (GRAPH_RESOURCE_TYPES.has(String(node.resource_type ?? ""))) out[id] = node;
  }
  for (const [id, source] of Object.entries(manifest.sources ?? {})) out[id] = source;
  return out;
}

/** Stable JSON representation for object-valued manifest fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function signature(resource: JsonRecord, macro = false, bodyOnly = false): string {
  // These are the parsed-manifest fields which determine a node/macro's
  // definition. Deliberately omit generated execution fields such as
  // compiled_code and compiled_path: recompiling the same project must not
  // make every model appear modified.
  const fields = macro
    ? {
      checksum: resource.checksum,
      macro_sql: resource.macro_sql,
      depends_on: resource.depends_on,
      arguments: resource.arguments,
      package_name: resource.package_name,
      path: resource.path,
      original_file_path: resource.original_file_path,
    }
    : bodyOnly
    ? {
      checksum: resource.checksum,
      raw_code: resource.raw_code ?? resource.raw_sql,
    }
    : {
      checksum: resource.checksum,
      raw_code: resource.raw_code ?? resource.raw_sql,
      config: resource.config,
      unrendered_config: resource.unrendered_config,
      database: resource.database,
      schema: resource.schema,
      alias: resource.alias,
      relation_name: resource.relation_name,
      description: resource.description,
      columns: resource.columns,
      depends_on: resource.depends_on,
      contract: resource.contract,
      constraints: resource.constraints,
      access: resource.access,
      version: resource.version,
      latest_version: resource.latest_version,
      deprecation_date: resource.deprecation_date,
      meta: resource.meta,
      tags: resource.tags,
      docs: resource.docs,
      patch_path: resource.patch_path,
      package_name: resource.package_name,
      path: resource.path,
      original_file_path: resource.original_file_path,
    };
  return JSON.stringify(canonical(fields));
}

function macroDependencies(resource: JsonRecord): string[] {
  const dependsOn = asRecord(resource.depends_on);
  const macros = dependsOn?.macros;
  return Array.isArray(macros) ? macros.filter((id): id is string => typeof id === "string") : [];
}

function changedMacroIds(current: StateManifest, previous: StateManifest): Set<string> {
  const currentMacros = current.macros ?? {};
  const previousMacros = previous.macros ?? {};
  const changed = new Set<string>();
  for (const [id, macro] of Object.entries(currentMacros)) {
    const prior = previousMacros[id];
    if (!prior || signature(macro, true) !== signature(prior, true)) changed.add(id);
  }

  // A model might invoke macro B which invokes changed macro A. Propagate the
  // change through current macro dependencies before identifying the models
  // that directly invoke an affected macro.
  let added = true;
  while (added) {
    added = false;
    for (const [id, macro] of Object.entries(currentMacros)) {
      if (!changed.has(id) && macroDependencies(macro).some((dep) => changed.has(dep))) {
        changed.add(id);
        added = true;
      }
    }
  }
  return changed;
}

function directModifiedIds(current: StateManifest, previous: StateManifest, bodyOnly = false): Set<string> {
  const currentResources = resourceMap(current);
  const previousResources = resourceMap(previous);
  const changed = new Set<string>();
  for (const [id, resource] of Object.entries(currentResources)) {
    const prior = previousResources[id];
    if (!prior || signature(resource, false, bodyOnly) !== signature(prior, false, bodyOnly)) changed.add(id);
  }
  // Macro changes are part of generic state:modified, but not the body-only
  // subselector. A body selector asks whether the model SQL itself changed.
  const changedMacros = bodyOnly ? new Set<string>() : changedMacroIds(current, previous);
  if (changedMacros.size) {
    for (const [id, resource] of Object.entries(currentResources)) {
      if (macroDependencies(resource).some((macro) => changedMacros.has(macro))) changed.add(id);
    }
  }
  return changed;
}

function walk(start: string, childMap: Record<string, string[]>, direction: "up" | "down", hops: number): Set<string> {
  if (hops <= 0) return new Set();
  const edges = new Map<string, string[]>();
  if (direction === "down") {
    for (const [from, to] of Object.entries(childMap)) edges.set(from, to);
  } else {
    for (const [from, to] of Object.entries(childMap)) {
      for (const child of to) (edges.get(child) ?? edges.set(child, []).get(child)!).push(from);
    }
  }
  const visited = new Set<string>();
  let frontier = [start];
  let depth = 0;
  while (frontier.length && depth < hops) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const adjacent of edges.get(id) ?? []) {
        if (!visited.has(adjacent)) { visited.add(adjacent); next.push(adjacent); }
      }
    }
    frontier = next;
    depth += 1;
  }
  return visited;
}

/** Resolve `state:modified`, its +/- graph expansion forms, and whitespace
 * unions using only two dbt artifacts. Returns undefined for selector grammar
 * that should remain dbt-owned. */
export function resolveLocalStateModified(
  current: StateManifest,
  previous: StateManifest,
  select: string,
): LocalStateResolution | undefined {
  const terms = parseLocalStateTerms(select);
  if (!terms) return undefined;
  const visible = new Set<string>();
  const modified = new Set<string>();
  const childMap = current.child_map ?? {};
  for (const term of terms) {
    const changed = directModifiedIds(current, previous, term.body);
    for (const id of changed) {
      modified.add(id);
      visible.add(id);
      for (const ancestor of walk(id, childMap, "up", term.up)) visible.add(ancestor);
      for (const descendant of walk(id, childMap, "down", term.down)) visible.add(descendant);
    }
  }
  // dbt ls was already constrained to the types represented by our graph.
  // A current manifest can contain test nodes in child_map, so enforce that
  // same restriction after walking the graph.
  const resources = resourceMap(current);
  return { ids: [...visible].filter((id) => id in resources).sort(), modifiedCount: modified.size };
}

function readManifest(file: string, label: string): StateManifest {
  if (!fs.existsSync(file)) throw new Error(`${label} manifest not found at ${file}`);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const manifest = asRecord(data);
    if (!manifest) throw new Error("not a JSON object");
    return manifest as StateManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${label} manifest at ${file}: ${message}`);
  }
}

/** Read the current target artifact and the `--state` comparison artifact. */
export function resolveLocalStateModifiedFromArtifacts(
  projectRoot: string,
  stateDirectory: string,
  select: string,
): LocalStateResolution | undefined {
  // Determine selector support before touching artifacts. Rich selectors still
  // receive the old dbt-ls implementation (and its complete dbt semantics).
  if (!parseLocalStateTerms(select)) return undefined;
  const current = readManifest(path.join(projectRoot, "target", "manifest.json"), "current");
  const priorRoot = path.resolve(projectRoot, stateDirectory);
  const previous = readManifest(path.join(priorRoot, "manifest.json"), "state");
  return resolveLocalStateModified(current, previous, select);
}
