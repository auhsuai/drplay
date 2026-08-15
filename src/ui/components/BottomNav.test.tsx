// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomNav } from "./BottomNav";
import { TABS } from "../../utils/driveConstants";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const onTabChange = vi.fn();

afterEach(() => {
  cleanup();
  onTabChange.mockClear();
});

describe("BottomNav", () => {
  it("renders the 4 static sidebar destinations", () => {
    render(<BottomNav activeTab={TABS.home} onTabChange={onTabChange} />);
    expect(
      screen.getByRole("button", { name: "sidebar.home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sidebar.my_drive" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sidebar.liked_songs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sidebar.settings" }),
    ).toBeInTheDocument();
  });

  it("marks exactly the active tab", () => {
    const { rerender } = render(
      <BottomNav activeTab={TABS.likedSongs} onTabChange={onTabChange} />,
    );
    expect(
      screen.getByRole("button", { name: "sidebar.liked_songs" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "sidebar.home" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: "sidebar.my_drive" }),
    ).not.toHaveAttribute("aria-current");

    rerender(
      <BottomNav activeTab={`playlist_123`} onTabChange={onTabChange} />,
    );
    expect(
      screen.getByRole("button", { name: "sidebar.my_drive" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "sidebar.settings" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("calls onTabChange with the tab key on click", () => {
    render(<BottomNav activeTab={TABS.home} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("button", { name: "sidebar.my_drive" }));
    expect(onTabChange).toHaveBeenCalledWith(TABS.myDrive);
    fireEvent.click(screen.getByRole("button", { name: "sidebar.settings" }));
    expect(onTabChange).toHaveBeenCalledWith(TABS.settings);
    fireEvent.click(screen.getByRole("button", { name: "sidebar.home" }));
    expect(onTabChange).toHaveBeenCalledWith(TABS.home);
  });

  it("uses compact sizing (h-14 bar, 20px tab icons, 10px labels)", () => {
    const { container } = render(
      <BottomNav activeTab={TABS.home} onTabChange={onTabChange} />,
    );
    const nav = container.querySelector("nav");
    expect(nav?.className).toContain("h-14");
    expect(nav?.className).not.toContain("h-16");
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("h-5");
    expect(svg?.getAttribute("class")).toContain("w-5");
    const label = container.querySelector("nav span");
    expect(label?.className).toContain("text-[10px]");
  });
});
