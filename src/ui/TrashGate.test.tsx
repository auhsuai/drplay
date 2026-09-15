// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashGate } from "./TrashGate";

vi.mock("./Settings/TrashScreen", () => ({
  TrashScreen: ({ token }: { token: string }) => (
    <div data-testid="trash-screen-stub" data-token={token} />
  ),
}));

afterEach(() => {
  cleanup();
});

describe("TrashGate logout reset (P2-12-4)", () => {
  it("showTrashScreen + token → render TrashScreen, không gọi onClose", () => {
    const onClose = vi.fn();
    render(<TrashGate showTrashScreen token="tok" onClose={onClose} />);

    expect(screen.getByTestId("trash-screen-stub")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("BUG regression: token về null (logout) → onClose gọi để reset state, không render", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <TrashGate showTrashScreen token="tok" onClose={onClose} />,
    );

    rerender(<TrashGate showTrashScreen token={null} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("trash-screen-stub")).toBeNull();
  });

  it("mount với state sót (showTrashScreen + token=null) → onClose, không render", () => {
    const onClose = vi.fn();
    render(<TrashGate showTrashScreen token={null} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("trash-screen-stub")).toBeNull();
  });
});
