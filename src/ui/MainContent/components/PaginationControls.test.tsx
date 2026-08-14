// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PaginationControls } from "./PaginationControls";

// Task 14: mobile hides the pagination UX entirely (virtual scroll replaces
// it). The hoisted getter lets one file exercise both platforms.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

function makeProps() {
  return {
    currentPage: 1,
    totalPages: 5,
    setCurrentPage: vi.fn(),
    onScrollTop: vi.fn(),
  };
}

describe("PaginationControls — mobile/desktop split (Task 14)", () => {
  it("renders nothing on mobile (no pagination UX, one virtual scroll)", () => {
    platformMock.IS_MOBILE = true;
    const { container } = render(<PaginationControls {...makeProps()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the prev/next controls on desktop", () => {
    platformMock.IS_MOBILE = false;
    const { getByText } = render(<PaginationControls {...makeProps()} />);
    expect(getByText("playlist.prev")).toBeTruthy();
    expect(getByText("playlist.next")).toBeTruthy();
  });

  it("stays hidden when there is a single page (desktop contract)", () => {
    platformMock.IS_MOBILE = false;
    const { container } = render(
      <PaginationControls {...makeProps()} totalPages={1} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
