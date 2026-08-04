// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Skeleton,
  SkeletonText,
  SkeletonCardGrid,
  SkeletonRowList,
} from "./Skeleton";

describe("Skeleton base", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with BASE_CLASS including motion-reduce:animate-none", () => {
    const { container } = render(<Skeleton width={10} height={10} />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("motion-reduce:animate-none");
  });

  it("base skeleton uses bright-enough dark tone (#3a3b3f) for contrast on real row bg (#202124)", () => {
    const { container } = render(<Skeleton width={10} height={10} />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("dark:bg-[#3a3b3f]");
    expect(el.className).not.toContain("dark:bg-[#2a2a2a]");
  });

  it("renders SkeletonText with its lines unchanged", () => {
    const { container } = render(<SkeletonText lines={2} />);
    const lines = container.querySelectorAll('div[aria-hidden="true"] > div');
    expect(lines).toHaveLength(2);
  });
});

describe("SkeletonCardGrid", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders rows x cols skeleton cards", () => {
    render(<SkeletonCardGrid cols={5} rows={2} />);
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(10);
  });

  it("container uses the exact HomeTab grid classes", () => {
    const { container } = render(<SkeletonCardGrid />);
    const grid = container.firstChild as HTMLElement;
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain(
      "grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6",
    );
  });

  it("each card has one aspect-square cover skeleton and two text-line skeletons", () => {
    const { container } = render(<SkeletonCardGrid cols={2} rows={1} />);
    const card = container.querySelector(
      '[data-testid="skeleton-card"]',
    ) as HTMLElement;
    expect(card.querySelectorAll(".aspect-square")).toHaveLength(1);
    expect(card.querySelectorAll('[class~="h-3.5"]')).toHaveLength(1);
    expect(card.querySelectorAll(".h-3")).toHaveLength(1);
  });
});

describe("SkeletonRowList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the requested number of rows, each with an icon and two text lines", () => {
    const { container } = render(<SkeletonRowList rows={3} />);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(3);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(row.querySelectorAll(".w-12.h-12")).toHaveLength(1);
    expect(row.querySelectorAll('[class~="h-4"]')).toHaveLength(1);
    expect(row.querySelectorAll(".h-3")).toHaveLength(1);
  });

  it("defaults to 8 rows when rows prop is omitted", () => {
    render(<SkeletonRowList />);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(8);
  });
});

describe("SkeletonRowList variants (dimensions mirror the real list rows)", () => {
  afterEach(() => {
    cleanup();
  });

  const textLinesInRow = (row: HTMLElement) => {
    const textBlock = row.querySelector(".flex-1.min-w-0") as HTMLElement;
    return textBlock.querySelectorAll('[aria-hidden="true"]').length;
  };

  const rowTokens = (row: HTMLElement) => row.className.split(/\s+/);

  it("default (audio) matches SongCard: 48px icon, two lines, gap-4 + p-3 (padding all four sides)", () => {
    const { container } = render(<SkeletonRowList rows={1} />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(rowTokens(row)).toContain("gap-4");
    expect(rowTokens(row)).toContain("p-3");
    expect(rowTokens(row)).not.toContain("py-3");
    expect(row.querySelectorAll(".w-12.h-12")).toHaveLength(1);
    expect(row.querySelectorAll('[class~="h-4"]')).toHaveLength(1);
    expect(row.querySelectorAll(".h-3")).toHaveLength(1);
    expect(textLinesInRow(row)).toBe(2);
  });

  it('variant="folder" matches FolderCard/JumpBackIn: 48px icon, two lines, p-4 (padding all four sides)', () => {
    const { container } = render(<SkeletonRowList rows={1} variant="folder" />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(rowTokens(row)).toContain("gap-4");
    expect(rowTokens(row)).toContain("p-4");
    expect(rowTokens(row)).not.toContain("py-4");
    expect(row.querySelectorAll(".w-12.h-12")).toHaveLength(1);
    expect(row.querySelectorAll('[class~="h-4"]')).toHaveLength(1);
    expect(row.querySelectorAll(".h-3")).toHaveLength(1);
    expect(textLinesInRow(row)).toBe(2);
  });

  it('variant="trash" matches TrashScreen: 40px icon, exactly ONE text line, gap-3 + p-3 (padding all four sides)', () => {
    const { container } = render(<SkeletonRowList rows={1} variant="trash" />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(rowTokens(row)).toContain("gap-3");
    expect(rowTokens(row)).toContain("p-3");
    expect(rowTokens(row)).not.toContain("py-3");
    expect(row.querySelectorAll(".w-10.h-10")).toHaveLength(1);
    expect(row.querySelectorAll('[class~="h-3.5"]')).toHaveLength(1);
    expect(row.querySelectorAll('[class~="h-4"]')).toHaveLength(0);
    expect(row.querySelectorAll(".h-3")).toHaveLength(0);
    expect(textLinesInRow(row)).toBe(1);
  });

  it("default (audio) rows carry the SongCard background + rounded-xl", () => {
    const { container } = render(<SkeletonRowList rows={1} />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(row.className).toContain("bg-[#F8F9FA] dark:bg-[#202124]");
    expect(row.className).toContain("rounded-xl");
  });

  it('variant="folder" rows carry the FolderCard/JumpBackIn background + rounded-xl', () => {
    const { container } = render(<SkeletonRowList rows={1} variant="folder" />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(row.className).toContain("bg-[#F8F9FA] dark:bg-[#202124]");
    expect(row.className).toContain("rounded-xl");
  });

  it('variant="trash" rows carry the TrashScreen gray-50 background + rounded-xl', () => {
    const { container } = render(<SkeletonRowList rows={1} variant="trash" />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    expect(row.className).toContain("bg-gray-50 dark:bg-[#202124]");
    expect(row.className).toContain("rounded-xl");
  });

  it("stretch still adds flex-1 to rows of every variant", () => {
    const { container } = render(
      <SkeletonRowList rows={2} variant="trash" stretch />,
    );
    const list = container.firstChild as HTMLElement;
    expect(list.className).toContain("h-full");
    for (const row of Array.from(
      container.querySelectorAll('[data-testid="skeleton-row"]'),
    )) {
      expect(row.className).toContain("flex-1");
    }
  });

  it("every variant icon skeleton carries the ring border mirroring the real icon box bg boundary", () => {
    const variants = ["audio", "folder", "trash"] as const;
    for (const variant of variants) {
      const { container } = render(
        <SkeletonRowList rows={1} variant={variant} />,
      );
      const row = container.querySelector(
        '[data-testid="skeleton-row"]',
      ) as HTMLElement;
      const icon =
        variant === "trash"
          ? row.querySelector(".w-10.h-10")
          : row.querySelector(".w-12.h-12");
      expect(icon, `variant=${variant}`).not.toBeNull();
      const iconEl = icon as HTMLElement;
      expect(iconEl.className).toContain("ring-1");
      expect(iconEl.className).toContain("ring-black/5");
      expect(iconEl.className).toContain("dark:ring-white/10");
    }
  });

  it('variant="folder" first text line is 3/4 width (mirrors long truncating folder names)', () => {
    const { container } = render(<SkeletonRowList rows={1} variant="folder" />);
    const row = container.querySelector(
      '[data-testid="skeleton-row"]',
    ) as HTMLElement;
    const firstLine = row.querySelector('[class~="h-4"]') as HTMLElement;
    expect(firstLine.className).toContain("w-3/4");
  });
});

describe("SkeletonRowList stretch (fills the loading region)", () => {
  afterEach(() => {
    cleanup();
  });

  it("stretch adds h-full to the container and flex-1 to every row", () => {
    const { container } = render(<SkeletonRowList rows={3} stretch />);
    const list = container.firstChild as HTMLElement;
    expect(list.className).toContain("h-full");
    const rows = Array.from(
      container.querySelectorAll('[data-testid="skeleton-row"]'),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.className).toContain("flex-1");
    }
  });

  it("keeps the non-stretch default untouched (no h-full / no flex-1)", () => {
    const { container } = render(<SkeletonRowList rows={2} />);
    const list = container.firstChild as HTMLElement;
    expect(list.className).not.toContain("h-full");
    for (const row of Array.from(
      container.querySelectorAll('[data-testid="skeleton-row"]'),
    )) {
      expect(row.className).not.toContain("flex-1");
    }
  });

  it("merges the caller className with the stretch classes", () => {
    const { container } = render(
      <SkeletonRowList rows={2} stretch className="flex-1" />,
    );
    const list = container.firstChild as HTMLElement;
    expect(list.className).toContain("h-full");
    expect(list.className).toContain("flex-1");
  });
});

describe("Skeleton accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("marks both new component containers as aria-hidden", () => {
    const { container: gridContainer } = render(<SkeletonCardGrid />);
    expect(
      (gridContainer.firstChild as HTMLElement).getAttribute("aria-hidden"),
    ).toBe("true");
    const { container: listContainer } = render(<SkeletonRowList />);
    expect(
      (listContainer.firstChild as HTMLElement).getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
