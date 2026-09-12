import { beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_FILES_URL } from "./driveFiles";
import { PAGINATION_PAGE_SIZE } from "./driveConstants";
import { getFolderAudioQuery } from "./audioQuery";
import { listFolderAudioFiles } from "./drivePagination";
import type { DriveFileItem } from "./driveTypes";

const driveFetchMock = vi.hoisted(() => vi.fn());

vi.mock("./driveApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./driveApi")>()),
  driveFetch: driveFetchMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function callUrl(index: number): URL {
  const call = driveFetchMock.mock.calls[index];
  if (call === undefined)
    throw new Error(`expected driveFetch call ${String(index)}`);
  return new URL(String(call[0]));
}

function file(id: string, name: string): DriveFileItem {
  return { id, name, mimeType: "audio/mpeg", size: "10" };
}

beforeEach(() => {
  driveFetchMock.mockReset();
});

describe("listFolderAudioFiles", () => {
  it("requests the folder audio query with a nextPageToken-aware mask and follows page tokens", async () => {
    driveFetchMock
      .mockResolvedValueOnce(
        jsonResponse({ files: [file("f1", "a.mp3")], nextPageToken: "tok-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ files: [file("f2", "b.mp3")] }));

    const result = await listFolderAudioFiles("token-1", "folder-1");

    expect(result.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(driveFetchMock).toHaveBeenCalledTimes(2);

    const first = callUrl(0);
    expect(first.origin + first.pathname).toBe(DRIVE_FILES_URL);
    expect(first.searchParams.get("q")).toBe(getFolderAudioQuery("folder-1"));
    expect(first.searchParams.get("fields")).toBe(
      "nextPageToken,files(id,name,mimeType,size)",
    );
    expect(first.searchParams.get("orderBy")).toBe("name");
    expect(first.searchParams.get("pageSize")).toBe(
      String(PAGINATION_PAGE_SIZE),
    );
    expect(first.searchParams.get("pageToken")).toBeNull();
    expect(driveFetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer token-1" },
    });

    expect(callUrl(1).searchParams.get("pageToken")).toBe("tok-2");
  });

  it("forwards the abort signal to driveFetch", async () => {
    driveFetchMock.mockResolvedValue(jsonResponse({ files: [] }));
    const controller = new AbortController();

    await listFolderAudioFiles("tok", "folder-1", controller.signal);

    expect(driveFetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("throws a status-tagged error on a non-OK response", async () => {
    driveFetchMock.mockResolvedValue(jsonResponse({}, 403));

    await expect(listFolderAudioFiles("tok", "folder-1")).rejects.toThrow(
      "Failed to list folder audio files (403)",
    );
  });

  it("classifies a 200 body that is not JSON as a malformed response", async () => {
    driveFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    await expect(listFolderAudioFiles("tok", "folder-1")).rejects.toThrow(
      "Failed to list folder audio files (malformed response)",
    );
  });

  it("propagates an AbortError rejection from driveFetch untouched", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    driveFetchMock.mockRejectedValue(abortError);

    await expect(
      listFolderAudioFiles("tok", "folder-1", new AbortController().signal),
    ).rejects.toBe(abortError);
  });

  it("does not call driveFetch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      listFolderAudioFiles("tok", "folder-1", controller.signal),
    ).resolves.toEqual([]);
    expect(driveFetchMock).not.toHaveBeenCalled();
  });
});
