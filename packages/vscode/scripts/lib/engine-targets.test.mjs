import { describe, expect, it } from "vitest";
import { REQUIRED_TARGETS, assertAllEnginesPresent, enginePathFor } from "./engine-targets.mjs";

describe("engine-targets", () => {
  it("names the win32 engine with a .exe suffix and others bare", () => {
    expect(enginePathFor("/root", "win32-x64")).toBe("/root/bin/win32-x64/lineage-engine.exe");
    expect(enginePathFor("/root", "darwin-arm64")).toBe("/root/bin/darwin-arm64/lineage-engine");
    expect(enginePathFor("/root", "linux-x64")).toBe("/root/bin/linux-x64/lineage-engine");
  });

  it("returns every required engine path when all are present", () => {
    const paths = assertAllEnginesPresent("/root", { existsFn: () => true });
    expect(paths).toHaveLength(REQUIRED_TARGETS.length);
    expect(paths).toContain("/root/bin/win32-x64/lineage-engine.exe");
    expect(paths).toContain("/root/bin/darwin-x64/lineage-engine");
  });

  it("throws listing every missing target so a platform can never ship engine-less", () => {
    const present = new Set(["/root/bin/win32-x64/lineage-engine.exe", "/root/bin/linux-x64/lineage-engine"]);
    expect(() => assertAllEnginesPresent("/root", { existsFn: (p) => present.has(p) })).toThrow(
      /darwin-arm64[\s\S]*darwin-x64|darwin-x64[\s\S]*darwin-arm64/,
    );
  });
});
