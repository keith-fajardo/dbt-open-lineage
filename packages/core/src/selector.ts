import type { Graph, GraphNode } from "./graphTypes";

interface Adj {
  down: Map<string, string[]>;
  up: Map<string, string[]>;
  byName: Map<string, string[]>;
  nodes: GraphNode[];
}

function buildAdj(g: Graph): Adj {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const n of g.nodes) {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name)!.push(n.id);
  }
  for (const e of g.edges) {
    (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to);
    (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from);
  }
  return { down, up, byName, nodes: g.nodes };
}

/** BFS from `start` following `edges`, up to `hops` levels (Infinity = all). */
function walk(start: string, edges: Map<string, string[]>, hops: number): Set<string> {
  const seen = new Set<string>();
  let frontier = [start];
  let depth = 0;
  while (frontier.length && depth < hops) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of edges.get(id) ?? []) {
        if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
      }
    }
    frontier = next;
    depth += 1;
  }
  return seen;
}

interface Term { up: number; name: string; down: number }

/** Parse `+model+`, `model+2`, `2+model`, `model` into hop counts (0 = none). */
function parseTerm(raw: string): Term {
  const m = raw.match(/^(\d*\+)?([^+]+?)(\+\d*)?$/);
  if (!m) return { up: 0, name: raw, down: 0 };
  const [, upTok, name, downTok] = m;
  const up = upTok ? (upTok === "+" ? Infinity : parseInt(upTok)) : 0;
  const down = downTok ? (downTok === "+" ? Infinity : parseInt(downTok.slice(1))) : 0;
  return { up, name, down };
}

/** Dotted lookup into a node's meta: "owner.team" → meta.owner.team. */
function metaValue(meta: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = meta;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Seed ids for a term core: a bare model name, or a dbt method selector —
 * `tag:v`, `config.materialized:v`, `config.meta.<key.path>:<v>`. Unknown
 * methods match nothing (mirrors an unknown model name). */
function matchCore(adj: Adj, core: string): string[] {
  const i = core.indexOf(":");
  if (i < 0) return adj.byName.get(core) ?? [];
  const method = core.slice(0, i);
  const value = core.slice(i + 1);
  if (method === "tag")
    return adj.nodes.filter((n) => n.tags?.includes(value)).map((n) => n.id);
  if (method === "config.materialized")
    return adj.nodes.filter((n) => (n.materialized ?? "") === value).map((n) => n.id);
  if (method === "unused") {
    // unused:sources — sources with NO downstream consumers at all (defined
    // in a .yml but never referenced by staging/int/mart models). Composes
    // with --exclude to hide them: "--exclude unused:sources".
    if (value !== "sources" && value !== "source") return [];
    return adj.nodes
      .filter((n) => n.resource_type === "source" && !adj.down.get(n.id)?.length)
      .map((n) => n.id);
  }
  if (method.startsWith("config.meta.")) {
    const key = method.slice("config.meta.".length);
    return adj.nodes
      .filter((n) => {
        const v = metaValue(n.meta, key);
        // Meta values can be strings, booleans, or numbers — compare textually.
        return v !== undefined && v !== null && typeof v !== "object" && String(v) === value;
      })
      .map((n) => n.id);
  }
  return [];
}

/** All nodes one `up+core+down` term matches (the seeds and their walked cones). */
function matchTerm(adj: Adj, raw: string): Set<string> {
  const { up, name, down } = parseTerm(raw);
  const out = new Set<string>();
  for (const id of matchCore(adj, name)) {
    out.add(id);
    if (up > 0) for (const a of walk(id, adj.up, up)) out.add(a);
    if (down > 0) for (const d of walk(id, adj.down, down)) out.add(d);
  }
  return out;
}

/** Resolve one selector expression (no --exclude handling): space-separated
 * tokens UNION; comma-separated sub-terms within a token INTERSECT — so
 * "a+,+d" is the path between a and d. Empty expression = whole graph. */
function resolveTerms(g: Graph, adj: Adj, expr: string): Set<string> {
  const q = expr.trim();
  if (!q) return new Set(g.nodes.map((n) => n.id));
  const result = new Set<string>();
  for (const raw of q.split(/\s+/)) {
    const sets = raw.split(",").filter(Boolean).map((part) => matchTerm(adj, part));
    if (sets.length === 0) continue;
    let inter = sets[0];
    for (const s of sets.slice(1)) inter = new Set([...inter].filter((id) => s.has(id)));
    for (const id of inter) result.add(id);
  }
  return result;
}

/** The focal model name the IDE targets the DAG at: the bare core of a
 * `+name+`-style single-term selector (strips the up/down hop operators).
 * Returns "" when the selector isn't a single bare-name term — a method
 * selector (`tag:mart`), a multi-token expr, or a comma-intersection — since
 * none of those name one focal model. Lets the DAG mark the OPEN model. */
export function focalName(query: string): string {
  const q = query.trim();
  if (!q || /\s/.test(q) || q.includes(",")) return "";
  const m = q.match(/^(?:\d*\+)?([^+:]+?)(?:\+\d*)?$/);
  return m ? m[1] : "";
}

export function resolveSelector(g: Graph, query: string): Set<string> {
  const q = query.trim();
  if (!q) return new Set(g.nodes.map((n) => n.id));
  const adj = buildAdj(g);
  // dbt-style exclusion: everything after `--exclude` is its own selector
  // whose matches are SUBTRACTED — "a+ --exclude config.materialized:view".
  // Multiple --exclude flags union; a bare trailing --exclude excludes
  // nothing (an empty exclude expression must NOT mean "everything").
  const chunks = q.split(/\s*--exclude\b\s*/);
  const included = resolveTerms(g, adj, chunks[0]);
  for (const ex of chunks.slice(1)) {
    if (!ex.trim()) continue;
    for (const id of resolveTerms(g, adj, ex)) included.delete(id);
  }
  return included;
}

const RUNNABLE = new Set(["model", "seed", "snapshot"]);

/** The reverse of resolveSelector: a set of node ids -> a dbt selector string
 * naming the runnable ones. dbt selector syntax matches by NAME, not the
 * manifest's unique_id, so this joins `node.name` (space = union in dbt
 * selector syntax). Sources and tests are never independently runnable —
 * sources aren't buildable and a selected model's tests come along for free
 * via `dbt test -s <models>` — so both are filtered out here. Sorted for a
 * deterministic, readable selector string. */
export function buildSelector(nodeIds: Set<string>, g: Graph): string {
  const names = new Set(
    g.nodes.filter((n) => nodeIds.has(n.id) && RUNNABLE.has(n.resource_type)).map((n) => n.name),
  );
  return [...names].sort().join(" ");
}
