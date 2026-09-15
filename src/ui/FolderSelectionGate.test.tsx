// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderSelectionGate } from "./FolderSelectionGate";

vi.mock("./FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => <div data-testid="folder-picker-stub" />,
}));

afterEach(() => {
  cleanup();
});

// P2-04-8: appRootFolder=null is the store's INITIAL placeholder, not proof
// that no root is configured. While useDriveInit still verifies the remote
// config (0.5s-15s of network), the gate must not paint the full-screen picker.
const baseProps: ComponentProps<typeof FolderSelectionGate> = {
  isLoggedIn: true,
  isHydrated: true,
  appRootFolder: null,
  showFolderSelection: false,
  token: "tok",
  onSelectFolder: vi.fn(),
  onCancel: undefined,
};

describe("FolderSelectionGate hydration guard (P2-04-8)", () => {
  it("BUG regression: does NOT render the picker while drive hydration is in flight", () => {
    render(<FolderSelectionGate {...baseProps} isHydrated={false} />);

    expect(screen.queryByTestId("folder-picker-stub")).toBeNull();
  });

  it("renders the picker once hydration settled and no root is configured", () => {
    render(<FolderSelectionGate {...baseProps} isHydrated={true} />);

    expect(screen.getByTestId("folder-picker-stub")).toBeTruthy();
  });

  it("an explicit user request (showFolderSelection) wins over the hydration guard", () => {
    render(
      <FolderSelectionGate
        {...baseProps}
        isHydrated={false}
        showFolderSelection={true}
      />,
    );

    expect(screen.getByTestId("folder-picker-stub")).toBeTruthy();
  });

  it("keeps the old contract: configured root + no explicit request → hidden", () => {
    render(<FolderSelectionGate {...baseProps} appRootFolder="root-X" />);

    expect(screen.queryByTestId("folder-picker-stub")).toBeNull();
  });

  it("keeps the old contract: logged out → hidden even when hydrated", () => {
    render(<FolderSelectionGate {...baseProps} isLoggedIn={false} />);

    expect(screen.queryByTestId("folder-picker-stub")).toBeNull();
  });
});
