// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mocks = vi.hoisted(() => ({
  getTrashedFiles: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../../utils/drivePagination", () => ({
  getTrashedFiles: mocks.getTrashedFiles,
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));

import { useTrashedFiles } from "./useTrashedFiles";

type FileItem = { id: string; name: string; mimeType: string };

type PendingCall = {
  token: string;
  signal: AbortSignal | undefined;
  resolve: (files: FileItem[]) => void;
};

let calls: PendingCall[] = [];

// Deferred harness: the fetch stays pending until the test resolves it, so a
// token change can happen mid-flight. rejectOnAbort models the real
// driveFetch abort behaviour (abort -> rejection).
function installMock({ rejectOnAbort = false } = {}) {
  mocks.getTrashedFiles.mockImplementation(
    (token: string, _q: string, signal?: AbortSignal) =>
      new Promise<FileItem[]>((resolve, reject) => {
        calls.push({ token, signal, resolve });
        if (rejectOnAbort) {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      }),
  );
}

function renderTrashedFiles(token: string) {
  return renderHook(
    ({ current }: { current: string }) => useTrashedFiles(current),
    {
      initialProps: { current: token },
    },
  );
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("useTrashedFiles stale-response guard (P2-05-5)", () => {
  it("discards a stale response from the previous token instead of overwriting the new list", async () => {
    installMock();
    const { result, rerender } = renderTrashedFiles("token-a");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe("token-a");

    act(() => {
      rerender({ current: "token-b" });
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.token).toBe("token-b");

    await act(async () => {
      calls[1]?.resolve([
        { id: "b1", name: "B track", mimeType: "audio/mpeg" },
      ]);
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);

    // The token-a response arrives late: it must NOT overwrite token-b's list.
    await act(async () => {
      calls[0]?.resolve([
        { id: "a1", name: "A track", mimeType: "audio/mpeg" },
      ]);
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);
    expect(mocks.captureError).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it("aborts the in-flight fetch on token change without logging or toasting", async () => {
    installMock({ rejectOnAbort: true });
    const { result, rerender } = renderTrashedFiles("token-a");
    expect(calls).toHaveLength(1);

    act(() => {
      rerender({ current: "token-b" });
    });

    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(mocks.captureError).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();

    await act(async () => {
      calls[1]?.resolve([
        { id: "b1", name: "B track", mimeType: "audio/mpeg" },
      ]);
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);
    expect(result.current.isLoading).toBe(false);
  });

  it("shows loading again while the new token's fetch is in flight", async () => {
    installMock({ rejectOnAbort: true });
    const { result, rerender } = renderTrashedFiles("token-a");

    await act(async () => {
      calls[0]?.resolve([]);
      await Promise.resolve();
    });
    expect(result.current.isLoading).toBe(false);

    act(() => {
      rerender({ current: "token-b" });
    });
    expect(result.current.isLoading).toBe(true);
  });

  it("aborts the fetch on unmount without logging or toasting", () => {
    installMock({ rejectOnAbort: true });
    const { unmount } = renderTrashedFiles("token-a");
    expect(calls).toHaveLength(1);

    unmount();

    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(mocks.captureError).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });
});
