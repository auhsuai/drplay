// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Task 14: on mobile the recently-added fetch must auto-run its pageToken
// loop to completion (no load-more UX); desktop keeps the historical single
// 100-item page. The hoisted getter lets one file exercise both platforms
// (IS_MOBILE is read at call time inside the function).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("./platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from "./apiClient";
import { getRecentlyAddedAudioFiles } from "./driveFiles";

const mockedFetch = vi.mocked(fetchWithAuth);

function makeFile(page: number, idx: number) {
  return {
    id: `p${String(page)}-f${String(idx)}`,
    name: `track-p${String(page)}-${String(idx)}.mp3`,
    mimeType: "audio/mpeg",
    size: "1000",
    modifiedTime: "2024-01-01T00:00:00.000Z",
  };
}

function makePage(
  files: Array<Record<string, unknown>>,
  nextPageToken?: string,
) {
  return {
    ok: true,
    json: () => ({ files, nextPageToken }),
  } as unknown as Response;
}

describe("getRecentlyAddedAudioFiles — mobile pageToken loop (Task 14)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    mockedFetch.mockReset();
  });

  it("runs all pages automatically and passes pageToken on the next request", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makePage(
          [0, 1, 2].map((i) => makeFile(1, i)),
          "tok-2",
        ),
      )
      .mockResolvedValueOnce(makePage([0, 1].map((i) => makeFile(2, i))));

    const files = await getRecentlyAddedAudioFiles("token");

    expect(files).toHaveLength(5);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const firstUrl = mockedFetch.mock.calls[0]?.[0] as string | undefined;
    const secondUrl = mockedFetch.mock.calls[1]?.[0] as string | undefined;
    expect(firstUrl).toContain("pageSize=1000");
    expect(secondUrl).toContain("pageToken=tok-2");
  });

  it("stops at the MAX_PAGINATION_PAGES safety cap instead of looping forever", async () => {
    const pages = Array.from({ length: 11 }, (_, pageIdx) =>
      makePage(
        [0, 1].map((i) => makeFile(pageIdx + 1, i)),
        "next",
      ),
    );
    for (const page of pages) mockedFetch.mockResolvedValueOnce(page);

    const files = await getRecentlyAddedAudioFiles("token");

    expect(files).toHaveLength(20);
    expect(mockedFetch).toHaveBeenCalledTimes(10);
  });

  it("desktop keeps the historical single 100-item page (no pageToken loop)", async () => {
    platformMock.IS_MOBILE = false;
    mockedFetch.mockResolvedValueOnce(
      makePage(
        [0, 1].map((i) => makeFile(1, i)),
        "tok-2",
      ),
    );

    const files = await getRecentlyAddedAudioFiles("token");

    expect(files).toHaveLength(2);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstUrl = mockedFetch.mock.calls[0]?.[0] as string | undefined;
    expect(firstUrl).toContain("pageSize=100");
    expect(firstUrl).not.toContain("pageToken");
  });
});
