import { describe, it, expect, vi, beforeEach } from "vitest";
import { mextBridge } from "./bridge";

describe("mextBridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("invoke() posts {id,cmd,args} to window.parent and resolves on a matching reply", async () => {
    const postMessageSpy = vi.spyOn(window.parent, "postMessage").mockImplementation((msg) => {
      const { id } = msg as { id: number };
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { id, ok: true, result: "pong" }, source: window.parent }),
        );
      });
    });

    const result = await mextBridge.invoke("dbt.manifest", { foo: "bar" });

    expect(result).toBe("pong");
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "dbt.manifest", args: { foo: "bar" } }),
      "*",
    );
  });

  it("ignores a reply whose event.source is not window.parent", async () => {
    let capturedId: number | undefined;
    vi.spyOn(window.parent, "postMessage").mockImplementation((msg) => {
      capturedId = (msg as { id: number }).id;
    });

    const promise = mextBridge.invoke("dbt.manifest", {});
    let settled = false;
    promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // A well-formed reply from a rogue source (not window.parent) must be ignored.
    window.dispatchEvent(
      new MessageEvent("message", { data: { id: capturedId, ok: true, result: "spoofed" }, source: null }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    // The genuine host reply (source === window.parent) still resolves it —
    // proves the spoofed message above didn't consume the pending entry.
    window.dispatchEvent(
      new MessageEvent("message", { data: { id: capturedId, ok: true, result: "real" }, source: window.parent }),
    );
    await expect(promise).resolves.toBe("real");
  });

  it("onContext() ignores pushes whose event.source is not window.parent", () => {
    const values: string[] = [];
    const unsubscribe = mextBridge.onContext((v) => values.push(v));

    window.dispatchEvent(new MessageEvent("message", { data: { evt: "context", value: "spoofed" }, source: null }));
    expect(values).toEqual([]);

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "context", value: "+dim_date+" }, source: window.parent }),
    );
    expect(values).toEqual(["+dim_date+"]);

    unsubscribe();
  });

  it("onRunEvent() forwards evt:'run' pushes from window.parent", () => {
    const events: unknown[] = [];
    const unsubscribe = mextBridge.onRunEvent((e) => events.push(e));

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } }, source: window.parent }),
    );
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);

    unsubscribe();
  });

  it("onRunEvent() ignores pushes whose event.source is not window.parent", () => {
    const events: unknown[] = [];
    mextBridge.onRunEvent((e) => events.push(e));

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 1 } }, source: null }),
    );
    expect(events).toEqual([]);
  });

  it("onManifestChanged() forwards evt:'manifestChanged' pushes from window.parent", () => {
    let fired = 0;
    const unsubscribe = mextBridge.onManifestChanged!(() => fired++);

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: window.parent }),
    );
    expect(fired).toBe(1);

    unsubscribe();
    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: window.parent }),
    );
    expect(fired).toBe(1);
  });

  it("onManifestChanged() ignores pushes whose event.source is not window.parent", () => {
    let fired = 0;
    mextBridge.onManifestChanged!(() => fired++);

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: null }),
    );
    expect(fired).toBe(0);
  });
});
