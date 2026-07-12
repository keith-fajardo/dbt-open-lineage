import { describe, it, expect, vi } from "vitest";
import { saveExport } from "./exportSave";

const b64 = Buffer.from("name\nstg_orders\n").toString("base64");

describe("saveExport", () => {
  it("writes the decoded bytes to the picked path", async () => {
    const write = vi.fn(async (_path: string, _bytes: Uint8Array) => {});
    const io = { pick: vi.fn(async () => "/tmp/out.csv"), write };
    const ok = await saveExport("dag-selection.csv", b64, io);
    expect(ok).toBe(true);
    expect(io.pick).toHaveBeenCalledWith("dag-selection.csv");
    const [, bytes] = write.mock.calls[0];
    expect(Buffer.from(bytes).toString("utf8")).toBe("name\nstg_orders\n");
  });
  it("returns false and does not write when the user cancels", async () => {
    const write = vi.fn(async () => {});
    const ok = await saveExport("x.csv", b64, { pick: async () => undefined, write });
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
