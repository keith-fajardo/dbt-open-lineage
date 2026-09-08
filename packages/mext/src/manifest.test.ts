import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("mext manifest host_perms", () => {
  it("allowlists dbt.ls (else Mnemo silently blocks the bridge call)", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "manifest.json"), "utf8"),
    );
    expect(manifest.host_perms).toContain("dbt.ls");
  });
});

describe("mext manifest version", () => {
  it("matches the package version used for the release", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "manifest.json"), "utf8"),
    );
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    );
    expect(manifest.version).toBe(pkg.version);
  });
});
