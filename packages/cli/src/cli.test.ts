import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli";

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
