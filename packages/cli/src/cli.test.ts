import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseArgs, isMainModule } from "./cli";

describe("parseArgs", () => {
  it("parses --flag value pairs into an object", () => {
    expect(parseArgs(["--manifest", "a.json", "--out", "./public"]))
      .toEqual({ manifest: "a.json", out: "./public" });
  });

  it("parses optional flags alongside required ones", () => {
    expect(parseArgs(["--manifest", "a.json", "--out", "./public", "--sidecar", "l.yml", "--title", "My Project"]))
      .toEqual({ manifest: "a.json", out: "./public", sidecar: "l.yml", title: "My Project" });
  });

  it("returns an empty object for no args", () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe("isMainModule", () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("matches when argv[1] is the real file path (direct `node out/cli.js` invocation)", () => {
    // realpathSync the tmpdir itself first: on macOS os.tmpdir() returns a
    // path through /var/folders/..., which is itself a symlink to
    // /private/var/folders/... — without resolving it here, `real` and
    // `realpathSync(real)` would differ even in the "no symlink" case,
    // which isn't what this test is about. import.meta.url is always
    // already fully resolved in real Node execution, so pre-resolving the
    // fixture path here matches production, not sidesteps the assertion.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dol-cli-mainmod-")));
    const real = join(dir, "cli.js");
    writeFileSync(real, "");
    expect(isMainModule(real, `file://${real}`)).toBe(true);
  });

  it("matches when argv[1] is a SYMLINK to the real file (the `npm link` bin case that broke in production)", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dol-cli-mainmod-")));
    const real = join(dir, "cli.js");
    const link = join(dir, "dbt-open-lineage");
    writeFileSync(real, "");
    symlinkSync(real, link);
    // import.meta.url always resolves symlinks; argv[1] (the invoked path) does not.
    expect(isMainModule(link, `file://${real}`)).toBe(true);
  });

  it("does not match an unrelated path (e.g. when imported by a test file)", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dol-cli-mainmod-")));
    const real = join(dir, "cli.js");
    const other = join(dir, "cli.test.js");
    writeFileSync(real, "");
    writeFileSync(other, "");
    expect(isMainModule(other, `file://${real}`)).toBe(false);
  });

  it("returns false (not throws) when argv[1] doesn't exist on disk", () => {
    expect(isMainModule("/nonexistent/path/cli.js", "file:///nonexistent/path/cli.js")).toBe(false);
  });
});
