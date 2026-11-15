import { beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_FILES_URL } from "./driveFiles";
import { fetchDriveFileById, listFolderAllEntries } from "./drivePagination";

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

beforeEach(() => {
  driveFetchMock.mockReset();
});

describe("listFolderAllEntries", () => {
  it("lists every child with trashed=false and the scan's field mask", async () => {
    driveFetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          { id: "f1", name: "a.mp3", mimeType: "audio/mpeg", size: "10" },
          {
            id: "f2",
            name: "Sub",
            mimeType: "application/vnd.google-apps.folder",
          },
        ],
      }),
    );
    const result = await listFolderAllEntries("token-1", "folder-1");
    expect(result.map((f) => f.id)).toEqual(["f1", "f2"]);
    const url = new URL(String(driveFetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(DRIVE_FILES_URL);
    expect(url.searchParams.get("q")).toBe(
      "'folder-1' in parents and trashed=false",
    );
    expect(url.searchParams.get("fields")).toContain("md5Checksum");
    expect(url.searchParams.get("fields")).toContain(
      "shortcutDetails(targetId)",
    );
    expect(url.searchParams.get("fields")).toContain(
      "capabilities/canDownload",
    );
    expect(url.searchParams.get("fields")).toContain("nextPageToken");
  });
});

describe("fetchDriveFileById", () => {
  it("fetches one file's metadata for shortcut resolution", async () => {
    driveFetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "target",
        name: "Real.mp3",
        mimeType: "audio/mpeg",
        size: "42",
        md5Checksum: "abc",
      }),
    );
    const result = await fetchDriveFileById("token-1", "target");
    expect(result.name).toBe("Real.mp3");
    expect(result.md5Checksum).toBe("abc");
    const url = new URL(String(driveFetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(`${DRIVE_FILES_URL}/target`);
    expect(url.searchParams.get("fields")).toContain("md5Checksum");
  });

  it("throws on a missing target so the scan can list it as unresolvable", async () => {
    driveFetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(fetchDriveFileById("token-1", "gone")).rejects.toThrow("404");
  });
});
