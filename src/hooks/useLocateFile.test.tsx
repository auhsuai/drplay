// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLocateFile } from "./useLocateFile";
import { captureError } from "../utils/errorLog";
import type { DriveFile } from "../db/db";

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const filesGetMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: fetchWithAuthMock,
}));

vi.mock("../db/db", () => ({
  db: { files: { get: filesGetMock } },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("react-i18next", () => {
  const t = (key: string, defaultValue?: unknown) =>
    typeof defaultValue === "string" ? defaultValue : key;
  return { useTranslation: () => ({ t }) };
});

const mockedFetch = fetchWithAuthMock;
const filesGet = filesGetMock;

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const TOKEN = "tok-123";
const CURRENT = "folder-current";

const FAKE_TIMERS_TOFAKE = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

let setters: {
  setCurrentFolderId: Mock;
  setCurrentFolderName: Mock;
  setFolderHistory: Mock;
  setActiveTab: Mock;
  setIsLoadingTracks: Mock;
};
let unmountHook: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
  vi.clearAllMocks();
  localStorage.clear();
  setters = {
    setCurrentFolderId: vi.fn(),
    setCurrentFolderName: vi.fn(),
    setFolderHistory: vi.fn(),
    setActiveTab: vi.fn(),
    setIsLoadingTracks: vi.fn(),
  };
});

afterEach(() => {
  unmountHook?.();
  unmountHook = undefined;
  vi.useRealTimers();
});

function mountLocate(token: string | null, currentFolderId: string) {
  const utils = renderHook(() =>
    useLocateFile(
      token,
      currentFolderId,
      setters.setCurrentFolderId,
      setters.setCurrentFolderName,
      setters.setFolderHistory,
      setters.setActiveTab,
      setters.setIsLoadingTracks,
    ),
  );
  unmountHook = utils.unmount;
  return utils;
}

function fireLocate(detail: unknown) {
  window.dispatchEvent(new CustomEvent("locate-file", { detail }));
}

async function flushAsyncWork() {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

async function locateAndWait(detail: unknown) {
  await act(async () => {
    fireLocate(detail);
    await flushAsyncWork();
  });
}

function seedDb(map: Record<string, Partial<DriveFile> | undefined>) {
  filesGet.mockImplementation((id: string) => Promise.resolve(map[id]));
}

function apiResp(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("useLocateFile — behavior contract", () => {
  it("locates a file via the Drive API, rebuilds history and navigates to the parent", async () => {
    seedDb({
      fa: { id: "fa", name: "File A", parentId: "parent-a" },
      "parent-a": { id: "parent-a", name: "Parent A", parentId: "root" },
    });
    mockedFetch.mockResolvedValue(apiResp({ parents: ["parent-a"] }));
    const { result } = mountLocate(TOKEN, "elsewhere");

    await locateAndWait({ fileId: "fa" });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch.mock.calls[0]?.[0]).toBe(
      `${DRIVE_FILES_URL}/fa?fields=parents`,
    );
    expect(setters.setActiveTab).toHaveBeenCalledWith("My Drive");
    expect(setters.setCurrentFolderId).toHaveBeenCalledWith("parent-a");
    expect(setters.setCurrentFolderName).toHaveBeenCalledWith("Parent A");
    expect(setters.setFolderHistory).toHaveBeenCalledTimes(1);
    const history = setters.setFolderHistory.mock.calls[0]?.[0] as Array<{
      id: string;
      name: string;
    }>;
    expect(history).toEqual([{ id: "root", name: "My Drive" }]);
    expect(history.some((entry) => entry.id === "elsewhere")).toBe(false);
    expect(result.current.highlightedFileId?.id).toBe("fa");
    expect(result.current.pendingEnsuredFileId.current).toBe("fa");
    expect(setters.setIsLoadingTracks.mock.calls).toEqual([[true], [false]]);
  });

  it("falls back to Dexie when the API responds !ok", async () => {
    seedDb({
      fb: { id: "fb", name: "File B", parentId: "parent-b" },
      "parent-b": { id: "parent-b", name: "Parent B", parentId: "root" },
    });
    mockedFetch.mockResolvedValue(apiResp({}, false));
    mountLocate(TOKEN, "other");

    await locateAndWait({ fileId: "fb" });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(setters.setCurrentFolderId).toHaveBeenCalledWith("parent-b");
    expect(setters.setCurrentFolderName).toHaveBeenCalledWith("Parent B");
    expect(setters.setFolderHistory).toHaveBeenCalledWith([
      { id: "root", name: "My Drive" },
    ]);
  });

  it("strips the drive_ prefix before looking the file up", async () => {
    seedDb({});
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result } = mountLocate(TOKEN, CURRENT);

    await locateAndWait({ fileId: `drive_pf1` });

    expect(mockedFetch.mock.calls[0]?.[0]).toBe(
      `${DRIVE_FILES_URL}/pf1?fields=parents`,
    );
    expect(result.current.highlightedFileId?.id).toBe("pf1");
  });

  it("is a no-op when accessToken is null", async () => {
    const { result } = mountLocate(null, CURRENT);

    await locateAndWait({ fileId: "fz" });

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(filesGet).not.toHaveBeenCalled();
    expect(setters.setIsLoadingTracks).not.toHaveBeenCalled();
    expect(result.current.highlightedFileId).toBeNull();
  });

  it("ignores malformed events without crashing", async () => {
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    mountLocate(TOKEN, CURRENT);

    await locateAndWait(undefined);
    await locateAndWait(null);
    await locateAndWait({});
    await locateAndWait({ fileId: 123 });

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(filesGet).not.toHaveBeenCalled();
    expect(setters.setIsLoadingTracks).not.toHaveBeenCalled();
  });

  it("caps rebuilt history at 20 ancestors", async () => {
    const map: Record<string, Partial<DriveFile>> = {
      deepfile: { id: "deepfile", name: "Deep File", parentId: "d1" },
    };
    for (let i = 1; i <= 25; i += 1) {
      map[`d${String(i)}`] = {
        id: `d${String(i)}`,
        name: `D${String(i)}`,
        parentId: `d${String(i + 1)}`,
      };
    }
    seedDb(map);
    mockedFetch.mockResolvedValue(apiResp({ parents: ["d1"] }));
    mountLocate(TOKEN, "far");

    await locateAndWait({ fileId: "deepfile" });

    expect(setters.setCurrentFolderId).toHaveBeenCalledWith("d1");
    const history = setters.setFolderHistory.mock.calls[0]?.[0] as Array<{
      id: string;
      name: string;
    }>;
    expect(history).toHaveLength(20);
    expect(history[0]?.name).toBe("D21");
    expect(history.some((entry) => entry.id === "d1")).toBe(false);
  });

  it("auto-clears the highlight after exactly 5000ms", async () => {
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result } = mountLocate(TOKEN, CURRENT);

    await locateAndWait({ fileId: "hl" });
    expect(result.current.highlightedFileId?.id).toBe("hl");

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current.highlightedFileId?.id).toBe("hl");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.highlightedFileId).toBeNull();
  });
});

describe("useLocateFile — regressions", () => {
  it("F1: drops a second locate-file while the first is still in flight", async () => {
    let releaseFirst!: (value: Response) => void;
    const firstCallGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    mockedFetch.mockImplementationOnce(() => firstCallGate);
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result } = mountLocate(TOKEN, CURRENT);

    await act(async () => {
      fireLocate({ fileId: "fa" });
      await flushAsyncWork();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireLocate({ fileId: "fb" });
      await flushAsyncWork();
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(setters.setIsLoadingTracks).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst(apiResp({ parents: [CURRENT] }));
      await flushAsyncWork();
    });
    expect(result.current.highlightedFileId?.id).toBe("fa");
  });

  it("F3: a newer highlight survives the older locate's pending timer", async () => {
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result } = mountLocate(TOKEN, CURRENT);

    await locateAndWait({ fileId: "fa" });
    expect(result.current.highlightedFileId?.id).toBe("fa");

    act(() => {
      vi.advanceTimersByTime(4900);
    });
    await locateAndWait({ fileId: "fb" });
    expect(result.current.highlightedFileId?.id).toBe("fb");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.highlightedFileId?.id).toBe("fb");

    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(result.current.highlightedFileId).toBeNull();
  });

  it("clears a pending highlight timer on unmount without throwing", async () => {
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result, unmount } = mountLocate(TOKEN, CURRENT);

    await locateAndWait({ fileId: "uc" });
    expect(result.current.highlightedFileId?.id).toBe("uc");

    expect(() => {
      act(() => {
        unmount();
        vi.advanceTimersByTime(6000);
      });
    }).not.toThrow();
  });
});

describe("useLocateFile — F4/F5 regressions", () => {
  function captureErrorLevels(): Array<string | undefined> {
    return (captureError as unknown as Mock).mock.calls.map(
      (call) => (call[0] as { level?: string } | undefined)?.level,
    );
  }

  function sentSignalOf(callIndex: number): AbortSignal | undefined {
    return (
      mockedFetch.mock.calls[callIndex]?.[1] as
        { signal?: AbortSignal } | undefined
    )?.signal;
  }

  it("F4: keeps locating with Unknown Folder when the main-path parent-name fetch fails", async () => {
    seedDb({ fc: { id: "fc", name: "File C", parentId: "parent-c" } });
    mockedFetch
      .mockResolvedValueOnce(apiResp({ parents: ["parent-c"] }))
      .mockRejectedValueOnce(new TypeError("Fetch failed"))
      .mockResolvedValue(apiResp({ parents: ["root"] }));
    mountLocate(TOKEN, "elsewhere");

    await act(async () => {
      fireLocate({ fileId: "fc" });
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(captureErrorLevels()).not.toContain("error");
    expect(setters.setCurrentFolderId).toHaveBeenCalledWith("parent-c");
    expect(setters.setCurrentFolderName).toHaveBeenCalledWith("Unknown Folder");
    expect(setters.setFolderHistory).toHaveBeenCalledWith([
      { id: "root", name: "My Drive" },
    ]);
    expect(setters.setIsLoadingTracks.mock.calls).toEqual([[true], [false]]);
  });

  it("F5: wires an AbortSignal into every Drive fetch it issues", async () => {
    seedDb({ fd: { id: "fd", name: "File D", parentId: "pe" } });
    mockedFetch
      .mockResolvedValueOnce(apiResp({ parents: ["pe"] }))
      .mockResolvedValueOnce(apiResp({ name: "Parent E" }))
      .mockResolvedValue(apiResp({ parents: ["root"] }));
    mountLocate(TOKEN, "elsewhere");

    await locateAndWait({ fileId: "fd" });

    expect(mockedFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < mockedFetch.mock.calls.length; i += 1) {
      expect(sentSignalOf(i)).toBeInstanceOf(AbortSignal);
    }
  });

  it("F5: unmounting mid-flight aborts the request signal and logs no error-level entry", async () => {
    let rejectGate!: (err: unknown) => void;
    const gate = new Promise<Response>((_resolve, reject) => {
      rejectGate = reject;
    });
    mockedFetch.mockImplementationOnce(() => gate);
    mountLocate(TOKEN, CURRENT);

    await act(async () => {
      fireLocate({ fileId: "fa" });
      await flushAsyncWork();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    unmountHook?.();
    unmountHook = undefined;

    await act(async () => {
      rejectGate(new DOMException("aborted", "AbortError"));
      await flushAsyncWork();
    });

    const signal = sentSignalOf(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(captureErrorLevels()).not.toContain("error");
    expect(setters.setCurrentFolderId).not.toHaveBeenCalled();
  });

  it("F5: changing deps mid-flight aborts the in-flight request signal", async () => {
    let rejectGate!: (err: unknown) => void;
    const gate = new Promise<Response>((_resolve, reject) => {
      rejectGate = reject;
    });
    mockedFetch.mockImplementationOnce(() => gate);
    const utils = renderHook(
      ({ token, folder }: { token: string | null; folder: string }) =>
        useLocateFile(
          token,
          folder,
          setters.setCurrentFolderId,
          setters.setCurrentFolderName,
          setters.setFolderHistory,
          setters.setActiveTab,
          setters.setIsLoadingTracks,
        ),
      { initialProps: { token: TOKEN, folder: CURRENT } },
    );
    unmountHook = utils.unmount;

    await act(async () => {
      fireLocate({ fileId: "fa" });
      await flushAsyncWork();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    utils.rerender({ token: TOKEN, folder: "folder-elsewhere" });

    await act(async () => {
      rejectGate(new DOMException("aborted", "AbortError"));
      await flushAsyncWork();
    });

    const signal = sentSignalOf(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(captureErrorLevels()).not.toContain("error");
    expect(setters.setCurrentFolderId).not.toHaveBeenCalled();
  });
});

describe("useLocateFile — B3 highlight payload contract (folderId)", () => {
  it("navigate path: highlight payload carries folderId === parentId", async () => {
    seedDb({
      fa: { id: "fa", name: "File A", parentId: "parent-a" },
      "parent-a": { id: "parent-a", name: "Parent A", parentId: "root" },
    });
    mockedFetch.mockResolvedValue(apiResp({ parents: ["parent-a"] }));
    const { result } = mountLocate(TOKEN, "elsewhere");

    await locateAndWait({ fileId: "fa" });

    const { highlightedFileId } = result.current;
    expect(highlightedFileId).toEqual({
      id: "fa",
      ts: highlightedFileId?.ts,
      folderId: "parent-a",
    });
    expect(typeof highlightedFileId?.ts).toBe("number");
  });

  it("same-folder path: highlight payload carries folderId === currentFolderId", async () => {
    mockedFetch.mockResolvedValue(apiResp({ parents: [CURRENT] }));
    const { result } = mountLocate(TOKEN, CURRENT);

    await locateAndWait({ fileId: "hl" });

    const { highlightedFileId } = result.current;
    expect(highlightedFileId).toEqual({
      id: "hl",
      ts: highlightedFileId?.ts,
      folderId: CURRENT,
    });
    expect(typeof highlightedFileId?.ts).toBe("number");
  });
});
