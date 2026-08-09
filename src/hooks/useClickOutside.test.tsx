// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useClickOutside } from "./useClickOutside";

// Repo runs vitest WITHOUT globals, so RTL's auto-cleanup never registers —
// without this, rendered DOM leaks across tests and getByTestId hits stale
// nodes from earlier tests (causing spurious "outside" hits).
afterEach(cleanup);

function Harness({
  handler,
  active,
  multiRef = false,
}: {
  handler: () => void;
  active?: boolean;
  multiRef?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  useClickOutside(multiRef ? [ref, secondRef] : ref, handler, active);
  return (
    <div>
      <div data-testid="inside" ref={ref}>
        inside
      </div>
      {multiRef && (
        <div data-testid="inside-second" ref={secondRef}>
          inside second
        </div>
      )}
      <button data-testid="outside">outside</button>
    </div>
  );
}

describe("useClickOutside", () => {
  it("calls the handler when clicking outside the referenced element", () => {
    const handler = vi.fn();
    render(<Harness handler={handler} />);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not call the handler when clicking inside the referenced element", () => {
    const handler = vi.fn();
    render(<Harness handler={handler} />);
    fireEvent.mouseDown(screen.getByTestId("inside"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not listen while active is false and starts listening when it becomes true", () => {
    const handler = vi.fn();
    const { rerender } = render(<Harness handler={handler} active={false} />);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(handler).not.toHaveBeenCalled();

    rerender(<Harness handler={handler} active />);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats a click inside any of multiple refs as inside", () => {
    const handler = vi.fn();
    render(<Harness handler={handler} multiRef />);
    fireEvent.mouseDown(screen.getByTestId("inside-second"));
    expect(handler).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount so no handler fires afterwards", () => {
    const handler = vi.fn();
    const { unmount } = render(<Harness handler={handler} />);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(handler).toHaveBeenCalledTimes(1);

    unmount();
    fireEvent.mouseDown(document.body);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
