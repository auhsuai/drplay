// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reloadMocks = vi.hoisted(() => ({ requestPlayerReload: vi.fn() }));

vi.mock("../player/reloadPlayer", () => ({
  requestPlayerReload: reloadMocks.requestPlayerReload,
}));

import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reloadMocks.requestPlayerReload.mockReset();
});

describe("ErrorBoundary reload action (F5)", () => {
  it("routes Reload through requestPlayerReload, never window.location.reload", () => {
    const boundaryRef = React.createRef<ErrorBoundary>();
    render(
      <ErrorBoundary ref={boundaryRef}>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    act(() => {
      boundaryRef.current?.setState({ hasError: true, error: new Error("x") });
    });

    // jsdom's location.reload is a non-configurable own property, so it cannot
    // be spied on. Routing is proven by the call below: the pre-fix handler
    // called window.location.reload directly and never reached this mock.
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reloadMocks.requestPlayerReload).toHaveBeenCalledTimes(1);
  });
});
