import { describe, it, expect } from "vitest";
import { resolveInProject } from "./projectFs";

describe("resolveInProject", () => {
  it("joins a relative path under the root", () => {
    expect(resolveInProject("/proj", "models/x.yml")).toBe("/proj/models/x.yml");
  });
  it("rejects parent-escape", () => {
    expect(() => resolveInProject("/proj", "../secrets.yml")).toThrow(/escapes project/);
  });
  it("rejects absolute paths", () => {
    expect(() => resolveInProject("/proj", "/etc/passwd")).toThrow(/escapes project/);
  });
});
