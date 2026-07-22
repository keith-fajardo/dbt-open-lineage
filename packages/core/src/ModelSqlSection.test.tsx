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
});
