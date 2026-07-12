/** Personal, machine-local favorites — a set of node ids per project, stored in
 * localStorage. Never committed, never on disk. All access is best-effort:
 * storage may be unavailable and stored data may be malformed. */
const PREFIX = "dol.personal.";

export function favoritesKey(projectPath: string): string {
  return PREFIX + projectPath;
}

export function loadFavorites(projectPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(favoritesKey(projectPath));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { favorites?: unknown };
    const list = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    return new Set(list.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveFavorites(projectPath: string, favorites: Set<string>): void {
  try {
    localStorage.setItem(favoritesKey(projectPath), JSON.stringify({ favorites: [...favorites] }));
  } catch {
    /* storage unavailable — favorites are best-effort */
  }
}
