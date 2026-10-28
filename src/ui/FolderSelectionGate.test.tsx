// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderSelectionGate } from "./FolderSelectionGate";
import type { RootFolder } from "../utils/rootFolders";
import en from "../locales/en/translation.json";

// The gate now renders its own recoverable surface (i18n), so resolve keys
// against the real English catalog instead of booting i18next.
vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string) => resolveKey(key) ?? key,
    }),
  };
});

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
  configError: null,
  onRetryConfig: vi.fn(),
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

// P1 conflation fix: a config read failure with no local roots must NOT show
// the first-run picker. The gate renders a recoverable surface instead, and the
// setup flow stays out of the DOM.
describe("FolderSelectionGate remote config unavailable", () => {
  it("shows the recoverable gate (not the setup flow) and wires Retry", () => {
    const onRetryConfig = vi.fn();
    render(
      <FolderSelectionGate
        {...baseProps}
        configError="unavailable"
        onRetryConfig={onRetryConfig}
      />,
    );

    expect(screen.getByTestId("config-unavailable-gate")).toBeTruthy();
    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps the hydration guard FIRST even when the config failed", () => {
    render(
      <FolderSelectionGate
        {...baseProps}
        isHydrated={false}
        configError="unavailable"
      />,
    );

    expect(screen.queryByTestId("config-unavailable-gate")).toBeNull();
    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();
  });

  it("an explicit user request (Settings -> Change folder) wins over the error gate", () => {
    render(
      <FolderSelectionGate
        {...baseProps}
        showFolderSelection={true}
        configError="unavailable"
      />,
    );

    expect(screen.queryByTestId("config-unavailable-gate")).toBeNull();
    expect(screen.getByTestId("setup-flow-stub")).toBeTruthy();
  });

  it("a configured root never shows the error gate", () => {
    render(
      <FolderSelectionGate
        {...baseProps}
        appRootFolder="root-X"
        configError="unavailable"
      />,
    );

    expect(screen.queryByTestId("config-unavailable-gate")).toBeNull();
    expect(screen.queryByTestId("setup-flow-stub")).toBeNull();
  });
});
