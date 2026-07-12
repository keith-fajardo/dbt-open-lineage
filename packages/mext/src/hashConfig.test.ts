import { describe, it, expect } from "vitest";
import { readHashConfig } from "./hashConfig";

describe("readHashConfig", () => {
  it("round-trips a normal project path", () => {
    const projectPath = "/Users/x/proj";
    const hash = `#projectPath=${encodeURIComponent(projectPath)}&context=${encodeURIComponent("+m+")}`;
    const config = readHashConfig(hash);
    expect(config.projectPath).toBe("/Users/x/proj");
    expect(config.initialSelector).toBe("+m+");
  });

  it("handles a path with a literal % without throwing", () => {
    const projectPath = "/Users/x/100% Done/proj";
    const hash = `#projectPath=${encodeURIComponent(projectPath)}`;
    // This would throw "URI malformed" if double-decoded (the old bug)
    const config = readHashConfig(hash);
    expect(config.projectPath).toBe("/Users/x/100% Done/proj");
  });

  it("returns empty strings for missing keys", () => {
    const hash = "#other=value";
    const config = readHashConfig(hash);
    expect(config.projectPath).toBe("");
    expect(config.initialSelector).toBe("");
  });

  it("handles hash with leading # or without", () => {
    const projectPath = "/Users/x/proj";
    const encoded = `projectPath=${encodeURIComponent(projectPath)}`;

    const withHash = readHashConfig(`#${encoded}`);
    const withoutHash = readHashConfig(encoded);

    expect(withHash.projectPath).toBe(projectPath);
    expect(withoutHash.projectPath).toBe(projectPath);
  });
});
