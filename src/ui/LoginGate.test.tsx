// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginGate } from "./LoginGate";

vi.mock("./Login/LoginScreen", () => ({
  LoginScreen: () => <div data-testid="login-screen-stub" />,
}));

afterEach(() => {
  cleanup();
});

const baseProps: Omit<ComponentProps<typeof LoginGate>, "isLoggedIn"> = {
  isAuthHydrated: true,
  onLogin: vi.fn(),
};

// P2-04-9: the auth store hydrates inside a useEffect (after commit/paint), so
// isLoggedIn=false is ambiguous on the first frames ("not logged in" vs "not
// hydrated yet"). The overlay must wait for the hydrate flag; otherwise a cold
// start with a saved session paints the login screen for at least one frame.
describe("LoginGate auth-hydration guard (P2-04-9)", () => {
  it("BUG regression: does NOT paint the login overlay while auth is not hydrated", () => {
    render(
      <LoginGate {...baseProps} isLoggedIn={false} isAuthHydrated={false} />,
    );

    expect(screen.queryByTestId("login-screen-stub")).toBeNull();
  });

  it("does not paint while hydrating even if the store already says logged in", () => {
    render(
      <LoginGate {...baseProps} isLoggedIn={true} isAuthHydrated={false} />,
    );

    expect(screen.queryByTestId("login-screen-stub")).toBeNull();
  });

  it("shows the login screen normally once hydrated and logged out", () => {
    render(
      <LoginGate {...baseProps} isLoggedIn={false} isAuthHydrated={true} />,
    );

    expect(screen.getByTestId("login-screen-stub")).toBeTruthy();
  });

  it("keeps the old contract: logged in + hydrated → no login overlay", () => {
    render(
      <LoginGate {...baseProps} isLoggedIn={true} isAuthHydrated={true} />,
    );

    expect(screen.queryByTestId("login-screen-stub")).toBeNull();
  });
});
