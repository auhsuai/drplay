// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { FolderSelectionGate } from "./FolderSelectionGate";

// Capture-props stub (precedent App.test.tsx mock of the same module).
const capturedProps: Record<string, unknown> = {};
vi.mock("./FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: (props: Record<string, unknown>) => {
    Object.assign(capturedProps, props);
    return <div data-testid="folder-selection-screen" />;
  },
}));

function gateProps(
  over: Partial<Parameters<typeof FolderSelectionGate>[0]> = {},
) {
  return {
    isLoggedIn: true,
    appRootFolder: null as string | null,
    showFolderSelection: false,
    token: "t" as string | null,
    onSelectFolder: vi.fn(),
    onCancel: undefined,
    ...over,
  };
}

function renderGate(props: ReturnType<typeof gateProps>) {
  return render(<FolderSelectionGate {...props} />);
}

afterEach(() => {
  cleanup();
});

describe("FolderSelectionGate token guard", () => {
  it("renders nothing when logged in but token is null (appRootFolder=null)", () => {
    const { container } = renderGate(gateProps({ token: null }));
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).toBeNull();
  });

  it("renders nothing when logged in but token is null (appRootFolder set)", () => {
    const { container } = renderGate(
      gateProps({ token: null, appRootFolder: "/root" }),
    );
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).toBeNull();
  });

  it("renders nothing when logged in but token is null (showFolderSelection forced)", () => {
    const { container } = renderGate(
      gateProps({
        token: null,
        appRootFolder: "/root",
        showFolderSelection: true,
      }),
    );
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).toBeNull();
  });

  it("keeps rendering nothing when not logged in", () => {
    const { container } = renderGate(gateProps({ isLoggedIn: false }));
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).toBeNull();
  });

  it("renders the picker when logged in with a token and no app root chosen", () => {
    const { container } = renderGate(gateProps({}));
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).not.toBeNull();
  });

  it("still hides itself when an app root exists and selection is not forced", () => {
    const { container } = renderGate(
      gateProps({ appRootFolder: "/root", showFolderSelection: false }),
    );
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).toBeNull();
  });

  it("forces the picker with a valid token when showFolderSelection is true and forwards the real token (not empty string)", () => {
    const { container } = renderGate(
      gateProps({ appRootFolder: "/root", showFolderSelection: true }),
    );
    expect(
      container.querySelector('[data-testid="folder-selection-screen"]'),
    ).not.toBeNull();
    expect(capturedProps["token"]).toBe("t");
  });
});
