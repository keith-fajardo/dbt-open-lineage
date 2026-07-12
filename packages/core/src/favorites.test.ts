// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { favoritesKey, loadFavorites, saveFavorites } from "./favorites";

beforeEach(() => localStorage.clear());

describe("favorites store", () => {
  it("is empty for a fresh project", () => {
    expect(loadFavorites("/p/a")).toEqual(new Set());
  });

  it("round-trips a saved set, scoped by project path", () => {
    saveFavorites("/p/a", new Set(["m1", "m2"]));
    expect(loadFavorites("/p/a")).toEqual(new Set(["m1", "m2"]));
    expect(loadFavorites("/p/b")).toEqual(new Set()); // other project unaffected
    expect(localStorage.getItem(favoritesKey("/p/a"))).toContain("m1");
  });

  it("tolerates garbage / malformed storage", () => {
    localStorage.setItem(favoritesKey("/p/a"), "not json");
    expect(loadFavorites("/p/a")).toEqual(new Set());
    localStorage.setItem(favoritesKey("/p/a"), JSON.stringify({ favorites: "nope" }));
    expect(loadFavorites("/p/a")).toEqual(new Set());
    localStorage.setItem(favoritesKey("/p/a"), JSON.stringify({ favorites: ["ok", 3] }));
    expect(loadFavorites("/p/a")).toEqual(new Set(["ok"]));
  });
});
