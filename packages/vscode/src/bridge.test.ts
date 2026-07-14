// @vitest-environment jsdom
//
// This is the first unit test for a webview-side (browser) file in this
// package — every other test here is Node-only host code (see
// vitest.config.ts's comment). vscode's vitest config therefore defaults to
// the "node" environment; the pragma above overrides it for this file only.
//
// bridge.ts calls acquireVsCodeApi() as a MODULE-LEVEL side effect. ES module
// imports are hoisted and evaluated before any of a test file's own top-level
// statements run, so a plain `globalThis.acquireVsCodeApi = ...` written
// above a static `import { vscodeBridge } from "./bridge"` would NOT run in
// time. Each test instead stubs the global first, then dynamically imports
// the module (with vi.resetModules() so the module's internal `seq`/`pending`
// state is fresh every time).
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("vscodeBridge", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let vscodeBridge: typeof import("./bridge")["vscodeBridge"];

  beforeEach(async () => {
    vi.resetModules();
    postMessageSpy = vi.fn();
    (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } }).acquireVsCodeApi =
      () => ({ postMessage: postMessageSpy });
    ({ vscodeBridge } = await import("./bridge"));
  });

  it("invoke() posts {id,cmd,args} via vscode.postMessage and resolves on a matching reply", async () => {
    const p = vscodeBridge.invoke("dbt.manifest", { foo: "bar" });
    const sent = postMessageSpy.mock.calls[0][0] as { id: number; cmd: string; args: unknown };
    expect(sent).toMatchObject({ cmd: "dbt.manifest", args: { foo: "bar" } });
    window.dispatchEvent(new MessageEvent("message", { data: { id: sent.id, ok: true, result: "pong" } }));
    await expect(p).resolves.toBe("pong");
  });

  it("onRunEvent() forwards evt:'run' pushes", () => {
    const events: unknown[] = [];
    const unsub = vscodeBridge.onRunEvent((e) => events.push(e));
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } } }));
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);
    unsub();
  });

  it("onRunEvent() ignores pushes for other event types", () => {
    const events: unknown[] = [];
    vscodeBridge.onRunEvent((e) => events.push(e));
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "context", value: "+dim_date+" } }));
    expect(events).toEqual([]);
  });

  it("unsubscribing stops further delivery", () => {
    const events: unknown[] = [];
    const unsub = vscodeBridge.onRunEvent((e) => events.push(e));
    unsub();
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } } }));
    expect(events).toEqual([]);
  });
});
