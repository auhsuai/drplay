// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { DriveItem } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
} from "../utils/downloadPath";
import { useBulkDownload } from "./useBulkDownload";
import type { FileDownloadProgressEvent } from "../utils/fileDownload";
import en from "../locales/en/translation.json";

const { MockChannel, startBehavior, listStub, metadataStub } = vi.hoisted(
  () => {
    class MockChannel {
      static instances: MockChannel[] = [];
      onmessage: (event: FileDownloadProgressEvent) => void;
      constructor(onmessage: (event: FileDownloadProgressEvent) => void) {
        this.onmessage = onmessage;
        MockChannel.instances.push(this);
      }
    }
    return {
      MockChannel,
      // fileId -> "ok" | error code string thrown by start_file_download.
      startBehavior: new Map<string, string>(),
      // folderId -> Drive listing entries the real scanFolderTree walks.
      // Mocked at the listing layer (not scanFolderTree itself): the scan
      // calls its own module-internal scanFolderTree, so mocking the
      // export would not intercept it — the real scan would hit the
      // network and hang.
      listStub: {
        entries: new Map<string, Array<Record<string, unknown>>>(),
        // When true, listings wait for the abort signal instead of
        // resolving (lets the cancel test interrupt a scan in flight).
        abortable: false,
      },
      // fileId -> metadata returned by fetchMetadataBestEffort.
      metadataStub: new Map<
        string,
        { metadata: Record<string, unknown>; fileGone: boolean }
      >(),
    };
  },
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: MockChannel,
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock("../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn(),
  getCustomDownloadPath: vi.fn(),
  setCustomDownloadPath: vi.fn(),
}));

vi.mock("../utils/drivePagination", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/drivePagination")>();
  return {
    ...actual,
    listFolderAllEntries: vi.fn(
      (
        _token: string,
        folderId: string,
        signal?: AbortSignal,
      ): Promise<Array<Record<string, unknown>>> => {
        if (listStub.abortable) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(listStub.entries.get(folderId) ?? []);
      },
    ),
    fetchDriveFileById: vi.fn(() =>
      Promise.reject(new Error("no target stub")),
    ),
  };
});

vi.mock("../utils/fileDownload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/fileDownload")>();
  return {
    ...actual,
    fetchMetadataBestEffort: vi.fn((fileId: string) => {
      const hit = metadataStub.get(fileId);
      if (hit) return Promise.resolve(hit);
      return Promise.resolve({
        metadata: { size: 50, mimeType: "audio/mpeg" },
        fileGone: false,
      });
    }),
  };
});

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);
const mockedGetCustomDownloadPath = vi.mocked(getCustomDownloadPath);
const mockedJoin = vi.mocked(join);

const t = ((key: string, options?: Record<string, unknown>) => {
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return "";
    }
  }
  if (typeof acc !== "string") return "";
  return acc.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const value = options?.[name];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  });
}) as unknown as TFunction;

const FOLDER_MIME = "application/vnd.google-apps.folder";

function setupListings(): void {
  listStub.entries.set("root", [
    { id: "f1", name: "a.mp3", mimeType: "audio/mpeg", size: "100" },
    { id: "sub", name: "Sub", mimeType: FOLDER_MIME },
  ]);
  listStub.entries.set("sub", [
    { id: "f2", name: "b.mp3", mimeType: "audio/mpeg", size: "200" },
  ]);
}

const folderItem: DriveItem = {
  id: "root",
  title: "My Folder",
  isFolder: true,
};

const looseItem: DriveItem = {
  id: "loose",
  title: "single.mp3",
  isFolder: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  MockChannel.instances.length = 0;
  startBehavior.clear();
  metadataStub.clear();
  listStub.entries.clear();
  setupListings();
  listStub.abortable = false;
  mockedGetValidToken.mockResolvedValue("tok");
  mockedGetEffectiveDownloadPath.mockResolvedValue("/Downloads");
  mockedGetCustomDownloadPath.mockReturnValue(null);
  mockedJoin.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    switch (cmd) {
      case "file_download_free_space":
        return Promise.resolve(10_000_000);
      case "ensure_download_directory":
      case "register_download_path":
        return Promise.resolve(undefined);
      case "pause_file_download":
      case "resume_file_download":
      case "cancel_file_download":
        return Promise.resolve(true);
      case "start_file_download": {
        const request = (
          args as {
            request: { fileId: string; downloadId: string };
          }
        ).request;
        const behavior = startBehavior.get(request.fileId) ?? "ok";
        if (behavior !== "ok") return Promise.reject(new Error(behavior));
        return Promise.resolve({
          path: "/Downloads/x",
          size: 100,
          resumed: false,
        });
      }
      default:
        return Promise.reject(new Error(`unexpected invoke ${cmd}`));
    }
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useBulkDownload", () => {
  it("downloads a mixed selection: loose file plus a whole folder tree", async () => {
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([looseItem, folderItem]);
    });
    expect(hook.result.current.isBulkDownloading).toBe(false);
    expect(hook.result.current.summary?.completed).toBe(3);
    expect(hook.result.current.summary?.total).toBe(3);
    expect(hook.result.current.summary?.failed).toHaveLength(0);
    expect(hook.result.current.bulkMessage).toContain(
      "Downloaded 3 of 3 files",
    );
    expect(hook.result.current.bulkMessageKind).toBe("success");
    // Loose file straight into /Downloads, folder files under /Downloads/My Folder.
    const starts = mockedInvoke.mock.calls.filter(
      (c) => c[0] === "start_file_download",
    );
    expect(starts).toHaveLength(3);
    const dests = starts.map(
      (c) => (c[1] as { request: { destPath: string } }).request.destPath,
    );
    expect(dests).toContain("/Downloads/single.mp3");
    expect(dests).toContain("/Downloads/My Folder/a.mp3");
    expect(dests).toContain("/Downloads/My Folder/Sub/b.mp3");
  });

  it("one failing file does not stop the job; the summary lists it", async () => {
    startBehavior.set("f2", "network: a network error occurred");
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([folderItem]);
    });
    expect(hook.result.current.summary?.completed).toBe(1);
    expect(hook.result.current.summary?.total).toBe(2);
    expect(hook.result.current.summary?.failed).toHaveLength(1);
    expect(hook.result.current.summary?.failed[0]?.name).toBe(
      "My Folder/Sub/b.mp3",
    );
    expect(hook.result.current.summary?.fatalKind).toBeUndefined();
    expect(hook.result.current.bulkMessage).toContain("1 failed");
    // A partial finish is an error toast (red "!"), not a success check.
    expect(hook.result.current.bulkMessageKind).toBe("error");
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(2);
  });

  it("a gone loose file counts as failed without invoking a download", async () => {
    metadataStub.set("loose", { metadata: {}, fileGone: true });
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([looseItem]);
    });
    expect(hook.result.current.summary?.completed).toBe(0);
    expect(hook.result.current.summary?.total).toBe(1);
    expect(hook.result.current.summary?.failed).toHaveLength(1);
    expect(hook.result.current.bulkMessage).toContain("1 failed");
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(0);
  });

  it("an unauthorized failure stops the whole job as fatal", async () => {
    startBehavior.set("f1", "unauthorized: the Google sign-in expired");
    startBehavior.set("f2", "unauthorized: the Google sign-in expired");
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([folderItem]);
    });
    expect(hook.result.current.summary?.fatalKind).toBe("unauthorized");
    expect(hook.result.current.summary?.cancelled).toBe(false);
  });

  it("refuses to start when the destination cannot fit the selection", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space") return Promise.resolve(150);
      return Promise.reject(new Error(`unexpected invoke ${cmd}`));
    });
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([folderItem]);
    });
    expect(hook.result.current.summary?.fatalKind).toBe("no_space");
    // The no_space toast must be the red "!" — the kind is what
    // DownloadToast's icon reads.
    expect(hook.result.current.bulkMessageKind).toBe("error");
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(0);
  });

  it("a selection with nothing downloadable reports empty instead of 0-file done", async () => {
    metadataStub.set("loose", {
      metadata: { mimeType: "application/vnd.google-apps.document" },
      fileGone: false,
    });
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      await hook.result.current.handleBulkDownload([looseItem]);
    });
    expect(hook.result.current.isBulkDownloading).toBe(false);
    expect(hook.result.current.bulkMessage).toContain(
      "Nothing in the selection can be downloaded.",
    );
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(0);
  });

  it("cancelling during the scan ends the job as cancelled", async () => {
    listStub.abortable = true;
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      const run = hook.result.current.handleBulkDownload([folderItem]);
      await hook.result.current.cancelBulkDownload();
      await run;
    });
    expect(hook.result.current.isBulkDownloading).toBe(false);
    expect(hook.result.current.summary?.cancelled).toBe(true);
    expect(hook.result.current.bulkMessage).toContain("Download cancelled.");
    expect(hook.result.current.bulkMessageKind).toBe("info");
  });

  it("previews the selection without starting a job: 2-file folder + 1 loose file = 3 files", async () => {
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      const plan = await hook.result.current.previewBulkSelection([
        looseItem,
        folderItem,
      ]);
      expect(plan?.totalFiles).toBe(3);
      // Folder files (100 + 200) + loose file (metadata default 50).
      expect(plan?.totalBytes).toBe(350);
    });
    expect(hook.result.current.previewPlan?.totalFiles).toBe(3);
    expect(hook.result.current.isPreviewing).toBe(false);
    expect(hook.result.current.isBulkDownloading).toBe(false);
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(0);
  });

  it("starts a planned subset: unticked files are never downloaded", async () => {
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      const plan = await hook.result.current.previewBulkSelection([
        looseItem,
        folderItem,
      ]);
      if (plan === null) throw new Error("preview returned no plan");
      // Keep only the loose file (plan order: folder files first, then
      // the loose file last).
      const subset = {
        ...plan,
        files: plan.files.filter((f) => f.rootSegments.length === 0),
        totalBytes: 50,
        totalFiles: 1,
      };
      await hook.result.current.startPlannedDownload(subset);
    });
    expect(hook.result.current.summary?.completed).toBe(1);
    expect(hook.result.current.summary?.total).toBe(1);
    const starts = mockedInvoke.mock.calls.filter(
      (c) => c[0] === "start_file_download",
    );
    expect(starts).toHaveLength(1);
    expect(
      (starts[0]?.[1] as { request: { fileId: string } }).request.fileId,
    ).toBe("loose");
  });

  it("cancelling one file lets the rest of the job finish", async () => {
    // Five files, concurrency 4: four run, one stays queued. Cancelling
    // a running file frees its slot for the queued one.
    listStub.entries.set("root", [
      { id: "f1", name: "a.mp3", mimeType: "audio/mpeg", size: "100" },
      { id: "f2", name: "b.mp3", mimeType: "audio/mpeg", size: "100" },
      { id: "f3", name: "c.mp3", mimeType: "audio/mpeg", size: "100" },
      { id: "f4", name: "d.mp3", mimeType: "audio/mpeg", size: "100" },
      { id: "f5", name: "e.mp3", mimeType: "audio/mpeg", size: "100" },
    ]);
    const started = new Set<string>();
    const resolvers = new Map<string, (v: unknown) => void>();
    const downloadIdToFile = new Map<string, string>();
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(10_000_000);
      if (cmd === "ensure_download_directory")
        return Promise.resolve(undefined);
      if (cmd === "cancel_file_download") {
        const downloadId = (args as { downloadId: string }).downloadId;
        const fileId = downloadIdToFile.get(downloadId);
        const reject = resolvers.get(fileId ?? "");
        resolvers.delete(fileId ?? "");
        reject?.(new Error("cancelled: user cancelled"));
        return Promise.resolve(true);
      }
      if (cmd === "start_file_download") {
        const request = (
          args as { request: { fileId: string; downloadId: string } }
        ).request;
        started.add(request.fileId);
        downloadIdToFile.set(request.downloadId, request.fileId);
        return new Promise((resolve, reject) => {
          resolvers.set(request.fileId, (v: unknown) => {
            if (v instanceof Error) reject(v);
            else resolve(v);
          });
        });
      }
      return Promise.resolve(undefined);
    });

    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      const run = hook.result.current.handleBulkDownload([folderItem]);
      await vi.waitFor(() => {
        expect(started.size).toBe(4);
      });
      await hook.result.current.cancelBulkFile(0);
      // The queued fifth file takes the freed slot.
      await vi.waitFor(() => {
        expect(started.size).toBe(5);
      });
      for (const [fileId, resolve] of [...resolvers.entries()]) {
        resolve({ path: `/Downloads/${fileId}`, size: 100, resumed: false });
      }
      await run;
    });

    expect(hook.result.current.summary?.completed).toBe(4);
    expect(hook.result.current.summary?.total).toBe(5);
    expect(hook.result.current.summary?.failed).toHaveLength(0);
    expect(hook.result.current.bulkFileStates[0]?.status).toBe("cancelled");
    expect(
      hook.result.current.bulkFileStates.filter((s) => s.status === "done"),
    ).toHaveLength(4);
  });

  it("ignores a second download while one job is running", async () => {
    listStub.abortable = true;
    const hook = renderHook(() => useBulkDownload(t));
    await act(async () => {
      const run = hook.result.current.handleBulkDownload([folderItem]);
      // Second call while the first job holds the guard: no second scan.
      await hook.result.current.handleBulkDownload([looseItem]);
      await hook.result.current.cancelBulkDownload();
      await run;
    });
    expect(hook.result.current.summary?.cancelled).toBe(true);
  });
});
