import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearchIndex, queryIndex } from "./searchEngine";
import type { SearchHit } from "./searchEngine";
import {
  handleSearchWorkerMessage,
  resetSearchWorkerState,
  type SearchWorkerDeps,
  type SearchWorkerRequest,
  type SearchWorkerResponse,
} from "./search.worker";
import type { DriveFile, MetadataCacheRow } from "../db/db";
import type { CachedMetadata } from "../utils/metadata";

// Worker handler tests run in the vitest node environment: handleSearchWorkerMessage
// is pure-ish with injectable deps (db/build/query/post), so no real Worker and
// no fake-indexeddb are needed — mirrors proSync.worker.test.ts.
// Module-level rebuild state is reset per test via resetSearchWorkerState().

const ROOT_ID = "root";
const META_VERSION = 2;

function makeFile(
  id: string,
  name: string,
  opts: { isFolder?: boolean; mimeType?: string } = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: opts.mimeType ?? "audio/mpeg",
    parentId: ROOT_ID,
    trashed: false,
    isFolder: opts.isFolder ?? false,
  };
}

function makeRealMeta(title: string, artist: string): CachedMetadata {
  return {
    title,
    artist,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: 5,
  };
}

function makeMetaRow(key: string, data: CachedMetadata): MetadataCacheRow {
  return { key, entry: { version: META_VERSION, data, ts: 0 } };
}

interface TestDeps extends SearchWorkerDeps {
  posts: SearchWorkerResponse[];
  buildSpy: ReturnType<typeof vi.fn>;
  querySpy: ReturnType<typeof vi.fn>;
}

function makeDeps(
  opts: {
    files?: DriveFile[];
    metaRows?: MetadataCacheRow[];
    buildImpl?: SearchWorkerDeps["build"];
    queryImpl?: SearchWorkerDeps["query"];
  } = {},
): TestDeps {
  const posts: SearchWorkerResponse[] = [];
  const buildSpy = vi.fn(
    opts.buildImpl ??
      ((files: DriveFile[], meta: ReadonlyMap<string, CachedMetadata>) =>
        buildSearchIndex(files, meta)),
  );
  const querySpy = vi.fn(opts.queryImpl ?? queryIndex);
  return {
    db: {
      files: { toArray: () => Promise.resolve(opts.files ?? []) },
      metadataCache: { toArray: () => Promise.resolve(opts.metaRows ?? []) },
    },
    build: buildSpy,
    query: querySpy,
    post: (r) => {
      posts.push(r);
    },
    posts,
    buildSpy,
    querySpy,
  };
}

function hitsOf(posts: SearchWorkerResponse[]): SearchHit[] {
  let last: SearchHit[] = [];
  for (const p of posts) {
    if (p.type === "results") last = p.hits;
  }
  return last;
}

function firstResult(posts: SearchWorkerResponse[]): SearchWorkerResponse {
  const r = posts[0];
  if (r === undefined) throw new Error("no response posted");
  return r;
}

describe("search.worker", () => {
  beforeEach(() => {
    resetSearchWorkerState();
  });

  it("1. init posts 'ready' without rebuilding", async () => {
    const deps = makeDeps();
    await handleSearchWorkerMessage({ type: "init" }, deps);
    expect(deps.posts).toEqual([{ type: "ready" }]);
    expect(deps.buildSpy).not.toHaveBeenCalled();
  });

  it("2. stale query rebuilds via deps.build and posts results with echoed requestId", async () => {
    const deps = makeDeps({
      files: [makeFile("f1", "Đổi thay.mp3"), makeFile("f2", "01 - abc.mp3")],
      metaRows: [
        makeMetaRow("metadata_f2", makeRealMeta("Nỗi buồn", "Ca sĩ X")),
      ],
    });
    await handleSearchWorkerMessage(
      { type: "query", requestId: 42, query: "doi", limit: 10 },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    const r = firstResult(deps.posts);
    expect(r.type).toBe("results");
    if (r.type === "results") {
      expect(r.requestId).toBe(42);
      expect(r.hits.map((h) => h.id)).toContain("f1");
    }
    // Real metadata flows through the worker pipeline too (fixture mirrors
    // searchEngine.test.ts): query by the metadata title.
    await handleSearchWorkerMessage(
      { type: "query", requestId: 43, query: "noi buon", limit: 10 },
      deps,
    );
    const r2 = deps.posts[1];
    if (r2?.type === "results") {
      expect(r2.hits.map((h) => h.id)).toContain("f2");
      expect(r2.hits.find((h) => h.id === "f2")?.title).toBe("Nỗi buồn");
    } else {
      throw new Error("expected results for metadata query");
    }
  });

  it("3. second query without invalidate does NOT rebuild (build spy count stays 1)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      { type: "query", requestId: 1, query: "anh", limit: 10 },
      deps,
    );
    await handleSearchWorkerMessage(
      { type: "query", requestId: 2, query: "anh", limit: 10 },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    expect(deps.posts).toHaveLength(2);
  });

  it("4. invalidate marks stale: next query rebuilds again (build count = 2)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      { type: "query", requestId: 1, query: "anh", limit: 10 },
      deps,
    );
    await handleSearchWorkerMessage({ type: "invalidate" }, deps);
    await handleSearchWorkerMessage(
      { type: "query", requestId: 2, query: "anh", limit: 10 },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(2);
    // invalidate posts nothing: exactly two results responses land
    expect(deps.posts).toHaveLength(2);
    expect(deps.posts[1]?.type).toBe("results");
  });

  it("5. empty or whitespace-only query posts [] without rebuilding", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      { type: "query", requestId: 5, query: "", limit: 10 },
      deps,
    );
    await handleSearchWorkerMessage(
      { type: "query", requestId: 6, query: "   ", limit: 10 },
      deps,
    );
    expect(deps.buildSpy).not.toHaveBeenCalled();
    expect(deps.posts).toEqual([
      { type: "results", requestId: 5, hits: [] },
      { type: "results", requestId: 6, hits: [] },
    ]);
  });

  it("6. rebuild failure posts {type:'error', requestId} and does NOT throw", async () => {
    const deps = makeDeps({
      buildImpl: () => {
        throw new Error("index boom");
      },
    });
    await expect(
      handleSearchWorkerMessage(
        { type: "query", requestId: 7, query: "anh", limit: 10 },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.posts[0]).toMatchObject({ type: "error", requestId: 7 });
    expect(deps.posts[0]).toHaveProperty(
      "message",
      expect.stringContaining("index boom"),
    );
    // After a failed rebuild the index stays stale: the next query retries
    // the rebuild instead of serving a broken index.
    await handleSearchWorkerMessage(
      { type: "query", requestId: 8, query: "anh", limit: 10 },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(2);
  });

  it("7. query failure posts {type:'error', requestId} after a successful rebuild", async () => {
    const deps = makeDeps({
      files: [makeFile("f1", "Anh.mp3")],
      queryImpl: () => {
        throw new Error("query boom");
      },
    });
    await expect(
      handleSearchWorkerMessage(
        { type: "query", requestId: 9, query: "anh", limit: 10 },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    expect(deps.posts[0]).toMatchObject({ type: "error", requestId: 9 });
    expect(deps.posts[0]).toHaveProperty(
      "message",
      expect.stringContaining("query boom"),
    );
  });

  it("8. two concurrent queries while stale share ONE rebuild (serialized)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await Promise.all([
      handleSearchWorkerMessage(
        { type: "query", requestId: 1, query: "anh", limit: 10 },
        deps,
      ),
      handleSearchWorkerMessage(
        { type: "query", requestId: 2, query: "anh", limit: 10 },
        deps,
      ),
    ]);
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    expect(deps.posts).toHaveLength(2);
    const resultIds = deps.posts
      .filter(
        (p): p is Extract<SearchWorkerResponse, { type: "results" }> =>
          p.type === "results",
      )
      .map((p) => p.requestId);
    expect(resultIds).toEqual(expect.arrayContaining([1, 2]));
    expect(hitsOf(deps.posts).map((h) => h.id)).toContain("f1");
  });

  it("9. non-object messages are ignored: no throw, no post", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await expect(
      handleSearchWorkerMessage(null as unknown as SearchWorkerRequest, deps),
    ).resolves.toBeUndefined();
    await expect(
      handleSearchWorkerMessage(
        "hello" as unknown as SearchWorkerRequest,
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.posts).toHaveLength(0);
    expect(deps.buildSpy).not.toHaveBeenCalled();
  });
});
