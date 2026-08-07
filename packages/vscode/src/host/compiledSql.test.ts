import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compiledCodeFromManifest, readCompiledSql, compiledDocUri, parseCompiledDocQuery,
  modelSqlFromManifest, readModelSql, analysisNodeFromManifest,
} from "./compiledSql";

const fixture = () =>
  fs.readFileSync(path.join(__dirname, "../../test/fixtures/manifest.min.json"), "utf8");

describe("compiledCodeFromManifest", () => {
  it("returns compiled sql when the node has compiled_code", () => {
    const c = compiledCodeFromManifest(fixture(), "model.proj.stg_orders");
    expect(c.compiled).toBe(true);
    expect(c.sql).toBe("select 1 as id from raw.orders");
  });
  it("reports not-compiled when the node lacks compiled_code", () => {
    const c = compiledCodeFromManifest(fixture(), "model.proj.mrt_orders");
    expect(c.compiled).toBe(false);
    expect(c.sql).toBe("");
  });
  it("throws for an unknown node id", () => {
    expect(() => compiledCodeFromManifest(fixture(), "model.proj.nope")).toThrow(/no node/);
  });
});

describe("readCompiledSql", () => {
  it("reads <root>/target/manifest.json and returns compiled code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbtcs-"));
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "target", "manifest.json"),
      JSON.stringify({ nodes: { "model.p.m": { compiled_code: "select 9" } } }),
    );
    expect(readCompiledSql(dir, "model.p.m")).toEqual({ sql: "select 9", compiled: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("compiledDocUri / parseCompiledDocQuery", () => {
  // Recompile fires while the virtual dbt-compiled: doc is the active editor —
  // resolving the project root from THAT editor's fsPath (as the old code did)
  // silently gives "/", pointing dbt at the wrong cwd (see extension.ts recompile
  // command). The uri must carry root itself so recompile never needs to re-derive
  // it from activeTextEditor.
  it("round-trips both the node id and the project root through the uri", () => {
    const uri = compiledDocUri("stg_orders", "model.proj.stg_orders", "/Users/me/proj");
    expect(uri.startsWith("dbt-compiled:/stg_orders.sql?")).toBe(true);
    const parsed = parseCompiledDocQuery(uri.split("?")[1]);
    expect(parsed).toEqual({ id: "model.proj.stg_orders", root: "/Users/me/proj" });
  });

  it("round-trips a root containing reserved uri characters (spaces, &, ?)", () => {
    const uri = compiledDocUri("m", "model.proj.m", "/Users/me/my projects/a&b?");
    const parsed = parseCompiledDocQuery(uri.split("?")[1]);
    expect(parsed).toEqual({ id: "model.proj.m", root: "/Users/me/my projects/a&b?" });
  });
});

describe("modelSqlFromManifest", () => {
  const manifest = JSON.stringify({
    nodes: {
      "model.p.m": { raw_code: "select {{ ref('x') }}", compiled_code: "select real.x" },
      "model.p.uncompiled": { raw_code: "select 1" },
    },
  });

  it("returns both raw and compiled when present", () => {
    expect(modelSqlFromManifest(manifest, "model.p.m")).toEqual({
      raw: "select {{ ref('x') }}",
      compiled: "select real.x",
    });
  });

  it("returns empty compiled when compiled_code is absent", () => {
    expect(modelSqlFromManifest(manifest, "model.p.uncompiled")).toEqual({
      raw: "select 1",
      compiled: "",
    });
  });

  it("throws when the node id is not in the manifest", () => {
    expect(() => modelSqlFromManifest(manifest, "model.p.missing")).toThrow(/no node model\.p\.missing/);
  });
});

describe("readModelSql", () => {
  it("reads <root>/target/manifest.json and returns raw + compiled code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbtms-"));
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "target", "manifest.json"),
      JSON.stringify({
        nodes: { "model.p.m": { raw_code: "select {{ ref('x') }}", compiled_code: "select real.x" } },
      }),
    );
    expect(readModelSql(dir, "model.p.m")).toEqual({ raw: "select {{ ref('x') }}", compiled: "select real.x" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("analysisNodeFromManifest", () => {
  const manifest = JSON.stringify({
    nodes: {
      "model.p.stg_x":  { resource_type: "model",    name: "stg_x", original_file_path: "models/staging/stg_x.sql" },
      "analysis.p.rev": { resource_type: "analysis", name: "rev",   original_file_path: "analyses/rev.sql" },
    },
  });
  it("resolves an analysis node by its file path", () =>
    expect(analysisNodeFromManifest(manifest, "analyses/rev.sql")).toEqual({ id: "analysis.p.rev", name: "rev" }));
  it("returns null for a non-analysis file path (a model)", () =>
    expect(analysisNodeFromManifest(manifest, "models/staging/stg_x.sql")).toBeNull());
  it("returns null when nothing matches", () =>
    expect(analysisNodeFromManifest(manifest, "analyses/missing.sql")).toBeNull());
  it("returns null on malformed json without throwing", () =>
    expect(analysisNodeFromManifest("not json", "analyses/rev.sql")).toBeNull());
});
