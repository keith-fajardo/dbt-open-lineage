import { describe, it, expect } from "vitest";
import { tokenizeCommand, buildGistPrompt, runGist, resolveBin, pickResolvedPath } from "./gist";

describe("resolveBin", () => {
  it("passes through a command that already has a path separator", () => {
    expect(resolveBin("/usr/local/bin/claude")).toBe("/usr/local/bin/claude");
    expect(resolveBin("./claude")).toBe("./claude");
    expect(resolveBin("C:\\tools\\claude.cmd")).toBe("C:\\tools\\claude.cmd");
  });
});

describe("pickResolvedPath", () => {
  // A login+interactive shell (needed so pyenv/venv init in .zshrc runs) can
  // print a startup banner to stdout BEFORE `command -v` — macOS
  // shell-session-restore emits "Restored session: <date>". `command -v`
  // prints exactly one path line, and shell init completes before it, so the
  // real path is always LAST. The old `.trim()` kept the banner glued to the
  // path, and spawning that 2-line blob as argv[0] failed with ENOENT.
  it("takes the last non-empty line when a banner precedes the path", () => {
    const stdout = "Restored session: Wed 22 Jul 2026 09:20:26 PST\n/Users/me/.pyenv/shims/dbt\n";
    expect(pickResolvedPath(stdout)).toBe("/Users/me/.pyenv/shims/dbt");
  });
  it("returns a clean single-line path unchanged", () => {
    expect(pickResolvedPath("/usr/local/bin/dbt\n")).toBe("/usr/local/bin/dbt");
  });
  it("returns empty string when there is no usable output", () => {
    expect(pickResolvedPath("  \n\n")).toBe("");
  });
});

describe("tokenizeCommand", () => {
  it("keeps {prompt} as ONE argv token even with spaces/quotes", () => {
    const argv = tokenizeCommand('claude -p "{prompt}"', 'a "b" c; rm -rf /');
    expect(argv).toEqual(["claude", "-p", 'a "b" c; rm -rf /']);
  });
  it("throws on an empty template", () => {
    expect(() => tokenizeCommand("   ", "x")).toThrow(/empty command/);
  });
});

describe("buildGistPrompt", () => {
  it("includes name, description, and compiled SQL", () => {
    const p = buildGistPrompt("stg_orders", "raw orders", "select 1");
    expect(p).toContain("stg_orders");
    expect(p).toContain("raw orders");
    expect(p).toContain("select 1");
  });
});

describe("runGist", () => {
  it("resolves trimmed stdout", async () => {
    const out = await runGist(["x"], { spawn: async () => ({ code: 0, stdout: "  gist  \n", stderr: "" }) });
    expect(out).toBe("gist");
  });
  it("rejects on non-zero exit with stderr", async () => {
    await expect(runGist(["x"], { spawn: async () => ({ code: 1, stdout: "", stderr: "boom" }) }))
      .rejects.toThrow(/boom/);
  });
  it("rejects on empty stdout", async () => {
    await expect(runGist(["x"], { spawn: async () => ({ code: 0, stdout: "  ", stderr: "" }) }))
      .rejects.toThrow(/no output/);
  });
});
