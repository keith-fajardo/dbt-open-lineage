import { describe, it, expect } from "vitest";
import { resolveStyles } from "./styles";

describe("resolveStyles", () => {
  it("uses the sidecar def when present", () => {
    const m = resolveStyles({ a: { name: "Alpha", color: "#111111" } }, ["a"]);
    expect(m.get("a")).toEqual({ name: "Alpha", color: "#111111" });
  });

  it("falls back to key + palette color, indexed by position in keys", () => {
    const m = resolveStyles({}, ["a", "b", "c"]);
    expect(m.get("a")!.name).toBe("a");
    expect(m.get("a")!.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    // stable-by-position: b and c get distinct palette colors from a
    expect(m.get("b")!.color).not.toBe(m.get("a")!.color);
    expect(m.get("c")!.color).not.toBe(m.get("b")!.color);
  });

  it("gives a key the SAME fallback color regardless of which subset is asked, as long as its index in keys is the same", () => {
    const full = resolveStyles({}, ["a", "b", "c"]);
    const same = resolveStyles({}, ["a", "b", "c"]);
    expect(same.get("b")!.color).toBe(full.get("b")!.color);
  });
});
