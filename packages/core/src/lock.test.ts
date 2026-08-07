import { describe, it, expect } from "vitest";
import { isLineageLocked, shouldConfirmSwitch } from "./lock";

describe("isLineageLocked", () => {
  it("locked when the manual toggle is on", () => expect(isLineageLocked(true, null)).toBe(true));
  it("auto-locked while a run is active", () => expect(isLineageLocked(false, "run")).toBe(true));
  it("unlocked when idle and toggle off", () => expect(isLineageLocked(false, null)).toBe(false));
  it("locked when both", () => expect(isLineageLocked(true, "build")).toBe(true));
});

describe("shouldConfirmSwitch", () => {
  it("confirms when locked with a live run", () => expect(shouldConfirmSwitch(true, true)).toBe(true));
  it("no confirm when not locked", () => expect(shouldConfirmSwitch(false, true)).toBe(false));
  it("no confirm when locked but no live run (idle manual lock)", () => expect(shouldConfirmSwitch(true, false)).toBe(false));
});
