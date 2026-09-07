import { describe, expect, it, vi } from "vitest";
import { readStableArtifact, readStableJsonText } from "./stableArtifact";

describe("readStableArtifact", () => {
  it("retries a manifest observed in the middle of a rewrite", async () => {
    const reads = ["{\"nodes\":", "{\"nodes\":{}}"];
    const wait = vi.fn(async () => {});

    const result = await readStableArtifact(
      "/project/target/manifest.json",
      JSON.parse,
      { attempts: 3, delayMs: 0, readText: async () => reads.shift()!, wait },
    );

    expect(result).toEqual({ nodes: {} });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("throws the final parse error after the retry budget is exhausted", async () => {
    const wait = vi.fn(async () => {});
    await expect(readStableJsonText("manifest.json", {
      attempts: 2,
      delayMs: 0,
      readText: async () => "{bad",
      wait,
    })).rejects.toThrow(SyntaxError);
    expect(wait).toHaveBeenCalledOnce();
  });
});
