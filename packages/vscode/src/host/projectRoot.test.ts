import { describe, it, expect } from "vitest";
import { findProjectRoot, resolveProjectRoot, projectRelativePath, nodeForFile, nodeIdForFile } from "./projectRoot";
import type { Graph } from "@dbt-open-lineage/core";

describe("findProjectRoot", () => {
  it("walks up to the dir containing dbt_project.yml", () => {
    const present = new Set(["/repo/dbt/dbt_project.yml"]);
    const exists = (p: string) => present.has(p);
    expect(findProjectRoot("/repo/dbt/models/staging", exists)).toBe("/repo/dbt");
  });
  it("returns null when none found", () => {
    expect(findProjectRoot("/a/b/c", () => false)).toBeNull();
  });
  it("walks Windows paths on every host OS", () => {
    const present = new Set(["C:\\repo\\dbt\\dbt_project.yml"]);
    expect(findProjectRoot(
      "C:\\repo\\dbt\\models\\staging",
      (candidate) => present.has(candidate),
    )).toBe("C:\\repo\\dbt");
  });
});

// A tiny in-memory filesystem for resolveProjectRoot: `files` are exact paths
// that exist; `listDirs` derives immediate child dirs from the set. Paths use
// "/" so the same fixtures read on any OS.
function fakeFs(paths: string[]) {
  const files = new Set(paths);
  const exists = (p: string) => files.has(p);
  const listDirs = (dir: string): string[] => {
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const kids = new Set<string>();
    for (const p of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const seg = rest.split("/")[0];
      if (rest.includes("/") && seg) kids.add(prefix + seg); // it's a dir (has children)
    }
    return [...kids];
  };
  return { exists, listDirs };
}

describe("resolveProjectRoot", () => {
  it("uses the active file's project when its scheme is a real file (walk up)", () => {
    const { exists, listDirs } = fakeFs(["/ws/he-dbt-bi/dbt_project.yml"]);
    expect(resolveProjectRoot({
      activeFileDir: "/ws/he-dbt-bi/models/staging",
      workspaceFolders: ["/ws"], exists, listDirs,
    })).toBe("/ws/he-dbt-bi");
  });

  it("finds a dbt project in a workspace SUBFOLDER when no file is active (Bug 1)", () => {
    // Workspace opened at the parent (GitHub); project lives in he-dbt-bi/.
    const { exists, listDirs } = fakeFs([
      "/GitHub/he-dbt-bi/dbt_project.yml",
      "/GitHub/he-dbt-bi/target/manifest.json",
      "/GitHub/some-other-repo/README.md",
    ]);
    expect(resolveProjectRoot({
      activeFileDir: undefined,
      workspaceFolders: ["/GitHub"], exists, listDirs,
    })).toBe("/GitHub/he-dbt-bi");
  });

  it("returns undefined (not a bogus root) when no dbt_project.yml exists anywhere (Bug 2)", () => {
    const { exists, listDirs } = fakeFs(["/temp/readonly/some-file.sql"]);
    expect(resolveProjectRoot({
      activeFileDir: "/temp/readonly",
      workspaceFolders: ["/temp/readonly"], exists, listDirs,
    })).toBeUndefined();
  });

  it("prefers the subfolder that already has target/manifest.json", () => {
    const { exists, listDirs } = fakeFs([
      "/ws/proj-a/dbt_project.yml",
      "/ws/proj-b/dbt_project.yml",
      "/ws/proj-b/target/manifest.json",
    ]);
    expect(resolveProjectRoot({
      activeFileDir: undefined,
      workspaceFolders: ["/ws"], exists, listDirs,
    })).toBe("/ws/proj-b");
  });

  it("searches all workspace folders, not just the first", () => {
    const { exists, listDirs } = fakeFs(["/second/dbt_project.yml"]);
    expect(resolveProjectRoot({
      activeFileDir: undefined,
      workspaceFolders: ["/first", "/second"], exists, listDirs,
    })).toBe("/second");
  });
});

describe("nodeIdForFile", () => {
  const g: Graph = { nodes: [
    { id: "model.p.stg_orders", name: "stg_orders", resource_type: "model", layer: "staging", path: "models/staging/stg_orders.sql", description: "" },
  ], edges: [] };
  it("maps an absolute file to its node name", () => {
    expect(nodeIdForFile(g, "/repo/dbt", "/repo/dbt/models/staging/stg_orders.sql")).toBe("stg_orders");
  });
  it("maps a Windows file to its forward-slash manifest path on every test OS", () => {
    expect(nodeIdForFile(
      g,
      "C:\\Users\\Keith\\dbt",
      "C:\\Users\\Keith\\dbt\\models\\staging\\stg_orders.sql",
    )).toBe("stg_orders");
  });
  it("returns the full graph node for Windows-safe compile eligibility checks", () => {
    expect(nodeForFile(
      g,
      "C:\\Users\\Keith\\dbt",
      "C:\\Users\\Keith\\dbt\\models\\staging\\stg_orders.sql",
    )?.id).toBe("model.p.stg_orders");
  });
  it("matches Windows drive paths case-insensitively", () => {
    expect(projectRelativePath(
      "c:\\users\\keith\\dbt",
      "C:\\Users\\Keith\\dbt\\models\\staging\\stg_orders.sql",
    )).toBe("models/staging/stg_orders.sql");
  });
  it("returns null for a file not in the graph", () => {
    expect(nodeIdForFile(g, "/repo/dbt", "/repo/dbt/models/other.sql")).toBeNull();
  });
});
