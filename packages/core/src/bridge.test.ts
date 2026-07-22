import { describe, it, expect, afterEach } from "vitest";
import { setBridge, onManifestChanged, type Bridge } from "./bridge";

// `setBridge` is module-global state (a single `active` variable shared by
// every test in the process) — restore a sane bridge after each test so a
// bridge missing optional methods here can't leak into unrelated test files
// that assume a full implementation is set.
const fullBridge: Bridge = {
  invoke: async () => undefined as never,
  saveExport: async () => true,
  openInIde: async () => true,
  onContext: () => () => {},
  onRunEvent: () => () => {},
  onManifestChanged: () => () => {},
};
afterEach(() => setBridge(fullBridge));

describe("onManifestChanged (optional-event fallback)", () => {
  it("does not throw and returns a callable no-op unsubscribe when the bridge omits onManifestChanged", () => {
    const { onManifestChanged: _omit, ...rest } = fullBridge;
    setBridge(rest as Bridge);
    let unsubscribe: (() => void) | undefined;
    expect(() => { unsubscribe = onManifestChanged(() => {}); }).not.toThrow();
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it("registers the callback and delegates the returned unsubscribe when the bridge provides onManifestChanged", () => {
    const cbs: Array<() => void> = [];
    const hostUnsubscribe = () => { hostUnsubscribeCalled = true; };
    let hostUnsubscribeCalled = false;
    setBridge({
      ...fullBridge,
      onManifestChanged: (cb) => { cbs.push(cb); return hostUnsubscribe; },
    });

    const cb = () => {};
    const unsubscribe = onManifestChanged(cb);
    expect(cbs).toEqual([cb]);

    unsubscribe();
    expect(hostUnsubscribeCalled).toBe(true);
  });
});
