import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compiledCodeFromManifest, readCompiledSql, compiledDocUri } from "./compiledSql";

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

describe("compiledDocUri", () => {
  it("builds a .sql virtual uri carrying the node id", () => {
    expect(compiledDocUri("stg_orders", "model.proj.stg_orders"))
      .toBe("dbt-compiled:/stg_orders.sql?model.proj.stg_orders");
  });
});
