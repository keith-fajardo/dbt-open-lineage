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
  it("resolves and confines Windows paths on every host OS", () => {
    expect(resolveInProject("C:\\repo\\dbt", "models\\x.yml"))
      .toBe("C:\\repo\\dbt\\models\\x.yml");
    expect(() => resolveInProject("C:\\repo\\dbt", "..\\secrets.yml"))
      .toThrow(/escapes project/);
  });
});
