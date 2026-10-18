// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderSelectionGate } from "./FolderSelectionGate";
import type { RootFolder } from "../utils/rootFolders";

vi.mock("./FolderSelection/RootFolderSetupFlow", () => ({
  RootFolderSetupFlow: (props: {
    currentRoots: RootFolder[];
    onCancel?: (() => void) | undefined;
  }) => (
    <div
      data-testid="setup-flow-stub"
      data-root-count={String(props.currentRoots.length)}
      data-has-cancel={props.onCancel ? "yes" : "no"}
    />
  ),
}));

afterEach(() => {
  cleanup();
});

// P2-04-8: appRootFolder=null is the store's INITIAL placeholder, not proof
// that no root is configured. While useDriveInit still verifies the remote
// config (0.5s-15s of network), the gate must not paint the setup flow.
const baseProps: ComponentProps<typeof FolderSelectionGate> = {
  isLoggedIn: true,
  isHydrated: true,
  appRootFolder: null,
  showFolderSelection: false,
  token: "tok",
  rootFolders: [],
  onCommitRoots: vi.fn(),
  onDone: vi.fn(),
  onCancel: undefined,
};

describe("FolderSelectionGate hydration guard (P2-04-8)", () => {
  it("BUG regression: does NOT render the setup flow while drive hydration is in flight", () => {
    render(<FolderSelectionGate {...baseProps} isHydrated={false} />);

    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();
  });

  it("renders the setup flow once hydration settled and no root is configured", () => {
    render(<FolderSelectionGate {...baseProps} isHydrated={true} />);

    expect(screen.getByTestId("setup-flow-stub")).toBeTruthy();
  });

  it("an explicit user request (showFolderSelection) wins over the hydration guard", () => {
    render(
      <FolderSelectionGate
        {...baseProps}
        isHydrated={false}
        showFolderSelection={true}
      />,
    );

    expect(screen.getByTestId("setup-flow-stub")).toBeTruthy();
  });

  it("keeps the old contract: configured root + no explicit request → hidden", () => {
    render(<FolderSelectionGate {...baseProps} appRootFolder="root-X" />);

    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();
  });

  it("keeps the old contract: logged out → hidden even when hydrated", () => {
    render(<FolderSelectionGate {...baseProps} isLoggedIn={false} />);

    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();
  });
});

describe("FolderSelectionGate setup-flow wiring (Slice C)", () => {
  it("passes the live root list and only forwards onCancel when a root exists", () => {
    const roots: RootFolder[] = [
      { id: "root-a", name: "Root A" },
      { id: "root-b", name: "Root B" },
    ];
    const onCancel = vi.fn();
    const { rerender } = render(
      <FolderSelectionGate
        {...baseProps}
        appRootFolder="root-a"
        showFolderSelection={true}
        rootFolders={roots}
        onCancel={onCancel}
      />,
    );

    const stub = screen.getByTestId("setup-flow-stub");
    expect(stub.getAttribute("data-root-count")).toBe("2");
    expect(stub.getAttribute("data-has-cancel")).toBe("yes");

    rerender(
      <FolderSelectionGate
        {...baseProps}
        appRootFolder={null}
        showFolderSelection={true}
        rootFolders={roots}
        onCancel={onCancel}
      />,
    );

    expect(
      screen.getByTestId("setup-flow-stub").getAttribute("data-has-cancel"),
    ).toBe("no");
  });
});
