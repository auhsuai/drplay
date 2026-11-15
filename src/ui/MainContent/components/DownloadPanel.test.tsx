// @vitest-environment jsdom
// DownloadPanel: preview counts files (never folders), tree expands,
// multi-select ticks files/folders; running mode shows the sky-blue
// per-file progress bar and per-file cancel.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import type { TFunction } from "i18next";
import { DownloadPanel } from "./DownloadPanel";
import type { BulkDownloadPlan } from "../../../utils/folderDownload";
import type { BulkFileState } from "../../../hooks/useBulkDownload";
import en from "../../../locales/en/translation.json";

// Plural-aware stub over the real English strings (i18next picks
// _one/_other by `count`; the repo's other stubs are identity mocks,
// which cannot express "1 file" vs "2 files").
const t = ((key: string, options?: Record<string, unknown>) => {
  const lookup = (k: string): unknown => {
    let acc: unknown = en;
    for (const part of k.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return acc;
  };
  let template: unknown = lookup(key);
  if (typeof template !== "string" && typeof options?.count === "number") {
    template = lookup(`${key}_${options.count === 1 ? "one" : "other"}`);
  }
  if (typeof template !== "string") return key;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const value = options?.[name];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  });
}) as unknown as TFunction;

function plannedFile(id: string, destRelativePath: string[], size = 100) {
  return {
    id,
    name: destRelativePath[destRelativePath.length - 1] ?? id,
    mimeType: "audio/mpeg",
    size,
    relativeDir: destRelativePath.slice(0, -1),
    destName: destRelativePath[destRelativePath.length - 1] ?? id,
    destRelativePath,
  };
}

const previewPlan: BulkDownloadPlan = {
  files: [
    { file: plannedFile("f1", ["a.mp3"]), rootSegments: ["Album"] },
    {
      file: plannedFile("f2", ["Sub", "b.mp3"]),
      rootSegments: ["Album"],
    },
    { file: plannedFile("f3", ["loose.mp3"]), rootSegments: [] },
  ],
  skipped: [],
  unavailable: [],
  roots: ["Album"],
  truncated: false,
  totalBytes: 300,
  totalFiles: 3,
};

function baseProps(over: Partial<Parameters<typeof DownloadPanel>[0]> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    isDownloading: false,
    previewPlan,
    isPreviewing: false,
    previewError: null,
    fileStates: [] as BulkFileState[],
    selectedIndices: new Set([0, 1, 2]),
    onToggleFile: vi.fn(),
    onToggleFolder: vi.fn(),
    onSelectAll: vi.fn(),
    onSelectNone: vi.fn(),
    onDownloadSelected: vi.fn(),
    onCancelJob: vi.fn(),
    onCancelFile: vi.fn(),
    t,
    ...over,
  };
}

afterEach(() => {
  cleanup();
});

describe("DownloadPanel preview", () => {
  it("counts files, never folders: 2-file folder + 1 loose file = 3 files", () => {
    render(<DownloadPanel {...baseProps()} />);

    expect(screen.getByText("3 of 3 files")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("a.mp3")).toBeInTheDocument();
    expect(screen.getByText("b.mp3")).toBeInTheDocument();
    expect(screen.getByText("loose.mp3")).toBeInTheDocument();
  });

  it("shows the ticked count, not the total, when files are unticked", () => {
    render(<DownloadPanel {...baseProps({ selectedIndices: new Set([0]) })} />);

    expect(screen.getByText("1 of 3 files")).toBeInTheDocument();
  });

  it("collapses a folder's subtree and expands it again", () => {
    render(<DownloadPanel {...baseProps()} />);
    expect(screen.getByText("b.mp3")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse Album"));
    expect(screen.queryByText("b.mp3")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand Album"));
    expect(screen.getByText("b.mp3")).toBeInTheDocument();
  });

  it("ticking a file calls onToggleFile with its plan index", () => {
    const onToggleFile = vi.fn();
    render(
      <DownloadPanel
        {...baseProps({ onToggleFile, selectedIndices: new Set() })}
      />,
    );

    fireEvent.click(screen.getByLabelText("loose.mp3"));
    expect(onToggleFile).toHaveBeenCalledWith(2);
  });

  it("ticking a folder calls onToggleFolder with every file under it", () => {
    const onToggleFolder = vi.fn();
    render(
      <DownloadPanel
        {...baseProps({ onToggleFolder, selectedIndices: new Set() })}
      />,
    );

    fireEvent.click(screen.getByLabelText("Album"));
    expect(onToggleFolder).toHaveBeenCalledWith([0, 1]);
  });

  it("Select all / Clear all call their handlers; Download is disabled with nothing ticked", () => {
    const onSelectAll = vi.fn();
    const onSelectNone = vi.fn();
    const onDownloadSelected = vi.fn();
    render(
      <DownloadPanel
        {...baseProps({
          onSelectAll,
          onSelectNone,
          onDownloadSelected,
          selectedIndices: new Set(),
        })}
      />,
    );

    fireEvent.click(screen.getByText("Select all"));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Clear all"));
    expect(onSelectNone).toHaveBeenCalledTimes(1);
    const download = screen.getByText("Download").closest("button");
    expect(download).toBeDisabled();
    fireEvent.click(screen.getByText("Download"));
    expect(onDownloadSelected).not.toHaveBeenCalled();
  });

  it("shows the truncated warning and the skipped count from the plan", () => {
    render(
      <DownloadPanel
        {...baseProps({
          previewPlan: {
            ...previewPlan,
            truncated: true,
            skipped: [
              {
                name: "Doc.gdoc",
                relativePath: "Doc.gdoc",
                reason: "native_doc",
              },
            ],
          },
        })}
      />,
    );

    expect(
      screen.getByText(
        "The list stopped at the scan limit — some files are not shown.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 item can't be downloaded and will be skipped."),
    ).toBeInTheDocument();
  });

  it("shows the scanning state while the preview loads", () => {
    render(
      <DownloadPanel
        {...baseProps({ isPreviewing: true, previewPlan: null })}
      />,
    );

    expect(screen.getByText("Reading the selection…")).toBeInTheDocument();
  });

  it("shows the preview error instead of the tree", () => {
    render(
      <DownloadPanel
        {...baseProps({
          previewError: "Couldn't refresh your Google sign-in.",
          previewPlan: null,
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't refresh your Google sign-in.",
    );
    expect(screen.queryByText("a.mp3")).toBeNull();
  });

  it("renders nothing when closed", () => {
    render(<DownloadPanel {...baseProps({ open: false })} />);

    expect(screen.queryByText("Downloads")).toBeNull();
  });
});

describe("DownloadPanel running", () => {
  function runningProps(
    over: Partial<Parameters<typeof DownloadPanel>[0]> = {},
  ) {
    const fileStates: BulkFileState[] = previewPlan.files.map((planned, i) => ({
      planned,
      status: i === 0 ? ("downloading" as const) : ("queued" as const),
      downloaded: i === 0 ? 50 : 0,
      total: 100,
      percent: i === 0 ? 50 : undefined,
    }));
    return baseProps({
      isDownloading: true,
      previewPlan: null,
      fileStates,
      ...over,
    });
  }

  it("shows a sky-blue bar under the downloading row at its percent", () => {
    const { container } = render(<DownloadPanel {...runningProps()} />);

    const bar = container.querySelector(".bg-sky-500");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("style")).toContain("width: 50%");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("shows no checkbox in running mode, and a per-file cancel that calls onCancelFile", () => {
    const onCancelFile = vi.fn();
    render(<DownloadPanel {...runningProps({ onCancelFile })} />);

    expect(screen.queryByLabelText("a.mp3")).toBeNull();
    // Every not-yet-finished row (downloading + queued) has its own
    // cancel; the first in DOM order is a.mp3 (plan index 0).
    const cancels = screen.getAllByLabelText("Cancel this file");
    expect(cancels).toHaveLength(3);
    const firstCancel = cancels[0];
    expect(firstCancel).toBeDefined();
    if (firstCancel) fireEvent.click(firstCancel);
    expect(onCancelFile).toHaveBeenCalledWith(0);
  });

  it("shows the completed count while running", () => {
    render(
      <DownloadPanel
        {...runningProps({
          fileStates: previewPlan.files.map((planned, i) => ({
            planned,
            status: i === 0 ? ("done" as const) : ("queued" as const),
            downloaded: i === 0 ? 100 : 0,
            total: 100,
            percent: i === 0 ? 100 : undefined,
          })),
        })}
      />,
    );

    expect(screen.getByText("1 of 3 files")).toBeInTheDocument();
  });
});
