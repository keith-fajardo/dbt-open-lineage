import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn(
  async (_cmd: string, _args?: Record<string, unknown>) =>
    ({ raw: "select {{ ref('x') }}", compiled: "select real.x" }),
);
vi.mock("./bridge", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>])),
}));

import { ModelSqlSection } from "./ModelSqlSection";

beforeEach(() => invokeMock.mockClear());
afterEach(cleanup);

describe("ModelSqlSection", () => {
  it("fetches dbt.modelSql for the node and shows raw SQL by default", async () => {
    render(<ModelSqlSection nodeId="model.p.x" />);
    await waitFor(() =>
      expect(screen.getByLabelText("model sql")).toHaveTextContent("select {{ ref('x') }}"),
    );
    expect(invokeMock).toHaveBeenCalledWith("dbt.modelSql", { id: "model.p.x" });
  });

  it("toggles to compiled SQL", async () => {
    render(<ModelSqlSection nodeId="model.p.x" />);
    await screen.findByLabelText("model sql");
    fireEvent.click(screen.getByRole("tab", { name: "compiled" }));
    expect(screen.getByLabelText("model sql")).toHaveTextContent("select real.x");
  });

  it("shows a hint when compiled SQL is empty", async () => {
    invokeMock.mockResolvedValueOnce({ raw: "select 1", compiled: "" });
    render(<ModelSqlSection nodeId="model.p.x" />);
    await screen.findByLabelText("model sql");
    fireEvent.click(screen.getByRole("tab", { name: "compiled" }));
    await waitFor(() => expect(screen.getByText(/Not compiled yet/)).toBeInTheDocument());
  });

  it("shows an error message when the fetch rejects", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no node model.p.x in manifest"));
    render(<ModelSqlSection nodeId="model.p.x" />);
    await waitFor(() => expect(screen.getByText(/SQL unavailable/)).toBeInTheDocument());
  });

  // Regression: a stale in-flight fetch for a PREVIOUS node must never
  // overwrite the SQL of the node the user has since selected. Node A's
  // response resolves LAST (after node B's), so only the `cancelled` guard
  // in the effect cleanup — not response ordering — can be protecting us.
  it("discards a stale response from a previous node that resolves after the current node's", async () => {
    let resolveA: (v: { raw: string; compiled: string }) => void = () => {};
    invokeMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveA = resolve; }),
    );
    const { rerender } = render(<ModelSqlSection nodeId="model.p.a" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.modelSql", { id: "model.p.a" }));

    invokeMock.mockResolvedValueOnce({ raw: "select b", compiled: "select real.b" });
    rerender(<ModelSqlSection nodeId="model.p.b" />);
    await waitFor(() =>
      expect(screen.getByLabelText("model sql")).toHaveTextContent("select b"),
    );

    resolveA({ raw: "select a", compiled: "select real.a" });
    // Give A's now-resolved promise a chance to flush into state if it were
    // going to (it shouldn't — the effect for node A was already cleaned up).
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByLabelText("model sql")).toHaveTextContent("select b");
  });

  it("copies the raw SQL text to the clipboard when the copy button is clicked", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText }, configurable: true,
    });
    render(<ModelSqlSection nodeId="model.p.x" />);
    await waitFor(() =>
      expect(screen.getByLabelText("model sql")).toHaveTextContent("select {{ ref('x') }}"),
    );
    fireEvent.click(screen.getByLabelText("copy sql"));
    expect(writeText).toHaveBeenCalledWith("select {{ ref('x') }}");
  });
});
