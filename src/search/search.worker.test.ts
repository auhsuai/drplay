import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearchIndex, queryIndex } from "./searchEngine";
import type { SearchHit } from "./searchEngine";
import {
  handleSearchWorkerMessage,
  resetSearchWorkerState,
  searchWorkerState,
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

// Every query frame must carry a scope (fail-closed wire, FIX 1/B2).
const defaultContext = {
  mode: "global" as const,
  rootIds: ["root"],
  sortField: "relevance" as const,
  sortDir: "desc" as const,
};

function makeFile(
  id: string,
  name: string,
  opts: {
    isFolder?: boolean;
    mimeType?: string;
    userEmail?: string;
    parentId?: string;
  } = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: opts.mimeType ?? "audio/mpeg",
    parentId: opts.parentId ?? ROOT_ID,
    trashed: false,
    isFolder: opts.isFolder ?? false,
    userEmail: opts.userEmail ?? "default", // compound PK part (schema v10)
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
      {
        type: "query",
        requestId: 42,
        query: "doi",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
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
      {
        type: "query",
        requestId: 43,
        query: "noi buon",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
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
      {
        type: "query",
        requestId: 1,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 2,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    expect(deps.posts).toHaveLength(2);
  });

  it("4. invalidate marks stale: next query rebuilds again (build count = 2)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 1,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    await handleSearchWorkerMessage({ type: "invalidate" }, deps);
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 2,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
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
      {
        type: "query",
        requestId: 5,
        query: "",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 6,
        query: "   ",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
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
        {
          type: "query",
          requestId: 7,
          query: "anh",
          limit: 10,
          userEmail: "default",
          context: defaultContext,
        },
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
      {
        type: "query",
        requestId: 8,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
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
        {
          type: "query",
          requestId: 9,
          query: "anh",
          limit: 10,
          userEmail: "default",
          context: defaultContext,
        },
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
        {
          type: "query",
          requestId: 1,
          query: "anh",
          limit: 10,
          userEmail: "default",
          context: defaultContext,
        },
        deps,
      ),
      handleSearchWorkerMessage(
        {
          type: "query",
          requestId: 2,
          query: "anh",
          limit: 10,
          userEmail: "default",
          context: defaultContext,
        },
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

  it("10. invalidate arriving mid-rebuild is not swallowed (index stays stale)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    // Deferred DB read keeps the rebuild parked mid-await so the test can
    // deliver invalidate exactly inside the DB-read window (precedent:
    // metadata.concurrency.test.ts generation-guard test).
    let resolveFiles!: (v: DriveFile[]) => void;
    const filesGate = new Promise<DriveFile[]>((resolve) => {
      resolveFiles = resolve;
    });
    deps.db.files.toArray = () => filesGate;

    // First query kicks off the rebuild; everything before the DB await runs
    // synchronously, so the rebuild is already in-flight after this call.
    const firstQuery = handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 10,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    await handleSearchWorkerMessage({ type: "invalidate" }, deps);
    resolveFiles([makeFile("f1", "Anh.mp3")]);
    await firstQuery;

    // The invalidate landed mid-rebuild: the freshly built snapshot predates
    // it, so stale must survive the rebuild instead of being reset to false,
    // and the in-flight rebuild must not publish its stale snapshot (it is
    // aborted before even calling deps.build).
    expect(searchWorkerState.stale).toBe(true);
    expect(deps.buildSpy).toHaveBeenCalledTimes(0);

    // The next query rebuilds with fresh data and leaves the index usable.
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 11,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: defaultContext,
      },
      deps,
    );
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);
    expect(searchWorkerState.stale).toBe(false);
    expect(deps.posts[deps.posts.length - 1]?.type).toBe("results");
  });

  it("11. rebuilds scoped to the query frame's userEmail (cross-account rows never indexed)", async () => {
    const deps = makeDeps({
      files: [
        makeFile("mine", "My Song.mp3", { userEmail: "me@x" }),
        makeFile("theirs", "Other Song.mp3", { userEmail: "other@x" }),
      ],
    });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 11,
        query: "song",
        limit: 10,
        userEmail: "me@x",
        context: defaultContext,
      },
      deps,
    );
    // The rebuild received ONLY the owner's rows...
    const buildArgs = deps.buildSpy.mock.calls[0];
    expect((buildArgs?.[0] as DriveFile[]).map((f) => f.id)).toEqual(["mine"]);
    // ...so the other account's file is unreachable through the index.
    expect(hitsOf(deps.posts).map((h) => h.id)).toEqual(["mine"]);
  });

  it("12. an owner change drops the stale index and rebuilds scoped to the new owner", async () => {
    const deps = makeDeps({
      files: [
        makeFile("mine", "My Song.mp3", { userEmail: "me@x" }),
        makeFile("theirs", "Other Song.mp3", { userEmail: "other@x" }),
      ],
    });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 12,
        query: "song",
        limit: 10,
        userEmail: "me@x",
        context: defaultContext,
      },
      deps,
    );
    expect(hitsOf(deps.posts).map((h) => h.id)).toEqual(["mine"]);

    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 13,
        query: "song",
        limit: 10,
        userEmail: "other@x",
        context: defaultContext,
      },
      deps,
    );
    // Owner switch forces a rebuild (call 2) with only the new owner's rows.
    expect(deps.buildSpy).toHaveBeenCalledTimes(2);
    const secondArgs = deps.buildSpy.mock.calls[1];
    expect((secondArgs?.[0] as DriveFile[]).map((f) => f.id)).toEqual([
      "theirs",
    ]);
    expect(hitsOf(deps.posts).map((h) => h.id)).toEqual(["theirs"]);
  });

  // ---- Root-scoped context (I1/B1/B2) -------------------------------------

  it("W1. empty rootIds posts [] WITHOUT rebuilding or querying (fail closed)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 20,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: { ...defaultContext, rootIds: [] },
      },
      deps,
    );
    expect(deps.posts).toEqual([{ type: "results", requestId: 20, hits: [] }]);
    expect(deps.buildSpy).not.toHaveBeenCalled();
    expect(deps.querySpy).not.toHaveBeenCalled();
  });

  it("W2. root-scoped query filters out-of-root hits before the limit", async () => {
    const deps = makeDeps({
      files: [
        makeFile("rootf", "Root Folder", {
          isFolder: true,
          mimeType: "application/vnd.google-apps.folder",
        }),
        makeFile("in1", "Song in.mp3", { parentId: "rootf" }),
        makeFile("in2", "Song in two.mp3", { parentId: "rootf" }),
        // Out-of-root: sits under an unconfigured parent AND outside rootf.
        makeFile("out", "Song out.mp3", { parentId: "elsewhere" }),
      ],
    });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 21,
        query: "song",
        limit: 2,
        userEmail: "default",
        context: { ...defaultContext, rootIds: ["rootf"] },
      },
      deps,
    );
    expect(
      hitsOf(deps.posts)
        .map((h) => h.id)
        .sort(),
    ).toEqual(["in1", "in2"]);
  });

  it("W3. recursive mode scopes to the current folder subtree (folder itself excluded)", async () => {
    const deps = makeDeps({
      files: [
        makeFile("foldA", "Folder A", {
          isFolder: true,
          mimeType: "application/vnd.google-apps.folder",
        }),
        makeFile("child1", "Song child.mp3", { parentId: "foldA" }),
        makeFile("other", "Song other.mp3", { parentId: "foldB" }),
      ],
    });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 22,
        query: "song",
        limit: 10,
        userEmail: "default",
        context: {
          mode: "recursive",
          rootIds: ["foldA"],
          currentFolderId: "foldA",
          sortField: "relevance",
          sortDir: "desc",
        },
      },
      deps,
    );
    expect(hitsOf(deps.posts).map((h) => h.id)).toEqual(["child1"]);
  });

  it("W4. recursive mode at VIRTUAL_ROOT degrades to global root scope", async () => {
    const deps = makeDeps({
      files: [
        makeFile("foldA", "Folder A", {
          isFolder: true,
          mimeType: "application/vnd.google-apps.folder",
          parentId: "root",
        }),
        makeFile("foldB", "Folder B", {
          isFolder: true,
          mimeType: "application/vnd.google-apps.folder",
          parentId: "root",
        }),
        makeFile("child1", "Song child.mp3", { parentId: "foldA" }),
        makeFile("child2", "Song child two.mp3", { parentId: "foldB" }),
      ],
    });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 23,
        query: "song",
        limit: 10,
        userEmail: "default",
        context: {
          mode: "recursive",
          rootIds: ["foldA", "foldB"],
          currentFolderId: "__drplay_virtual_root__",
          sortField: "relevance",
          sortDir: "desc",
        },
      },
      deps,
    );
    const ids = hitsOf(deps.posts).map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(["child1", "child2"]));
  });

  it("W5. query passes the sort spec through to the engine", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Song.mp3")] });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 24,
        query: "song",
        limit: 10,
        userEmail: "default",
        context: {
          mode: "global",
          rootIds: ["root"],
          sortField: "name",
          sortDir: "asc",
        },
      },
      deps,
    );
    expect(deps.querySpy).toHaveBeenCalledWith(
      expect.anything(),
      "song",
      10,
      expect.objectContaining({ mode: "global", rootIds: ["root"] }),
      { field: "name", dir: "asc" },
    );
  });

  it("W6. membership cache: same owner+roots reuses the BFS (no recompute), invalidate drops it", async () => {
    // computeRootMembership runs a wildcard search over the index — spying on
    // deps.query is not enough; instead count buildParentToChildren
    // invocations through the index identity: simplest observable is that the
    // second query posts identical hits without a rebuild (index reuse) and
    // that an invalidate (which resets the cache) does not crash the next
    // scoped query. Direct BFS-count proof lives in the engine tests; here we
    // pin the CONTRACT: cached path returns identical results.
    const deps = makeDeps({
      files: [
        makeFile("foldA", "Folder A", {
          isFolder: true,
          mimeType: "application/vnd.google-apps.folder",
        }),
        makeFile("child1", "Song child.mp3", { parentId: "foldA" }),
      ],
    });
    const post = (requestId: number): Promise<void> =>
      handleSearchWorkerMessage(
        {
          type: "query",
          requestId,
          query: "song",
          limit: 10,
          userEmail: "default",
          context: { ...defaultContext, rootIds: ["foldA"] },
        },
        deps,
      );
    await post(30);
    const first = hitsOf(deps.posts);
    await post(31);
    expect(hitsOf(deps.posts)).toEqual(first);
    expect(deps.buildSpy).toHaveBeenCalledTimes(1);

    // invalidate -> membership cache reset -> next query still correct.
    await handleSearchWorkerMessage({ type: "invalidate" }, deps);
    await post(32);
    expect(deps.buildSpy).toHaveBeenCalledTimes(2);
    expect(hitsOf(deps.posts)).toEqual(first);
  });

  it("W7. frame WITHOUT context fails closed: answers [] for its requestId, no rebuild, no query", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 40,
        query: "anh",
        limit: 10,
        userEmail: "default",
      } as unknown as SearchWorkerRequest,
      deps,
    );
    // Fail-closed answer (B2.1): the caller gets an empty result set for its
    // own requestId, and nothing unscoped ever runs.
    expect(deps.posts).toEqual([{ type: "results", requestId: 40, hits: [] }]);
    expect(deps.buildSpy).not.toHaveBeenCalled();
    expect(deps.querySpy).not.toHaveBeenCalled();
  });

  it("W7b. invalid rootIds (non-string / empty string / not an array) fail closed", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    const badContexts: unknown[] = [
      { ...defaultContext, rootIds: "root" },
      { ...defaultContext, rootIds: ["root", 42] },
      { ...defaultContext, rootIds: [""] },
      { ...defaultContext, sortDir: "sideways" },
    ];
    for (const [i, bad] of badContexts.entries()) {
      await handleSearchWorkerMessage(
        {
          type: "query",
          requestId: 50 + i,
          query: "anh",
          limit: 10,
          userEmail: "default",
          context: bad,
        } as unknown as SearchWorkerRequest,
        deps,
      );
    }
    expect(deps.posts).toEqual(
      badContexts.map((_, i) => ({
        type: "results",
        requestId: 50 + i,
        hits: [],
      })),
    );
    expect(deps.buildSpy).not.toHaveBeenCalled();
    expect(deps.querySpy).not.toHaveBeenCalled();
  });

  it("W8. malformed context fails CLOSED for its requestId (no rebuild, no query, no crash)", async () => {
    const deps = makeDeps({ files: [makeFile("f1", "Anh.mp3")] });
    await handleSearchWorkerMessage(
      {
        type: "query",
        requestId: 41,
        query: "anh",
        limit: 10,
        userEmail: "default",
        context: {
          mode: "bogus" as "global",
          rootIds: ["root"],
          sortField: "relevance",
          sortDir: "desc",
        },
      } as unknown as SearchWorkerRequest,
      deps,
    );
    expect(deps.posts).toEqual([{ type: "results", requestId: 41, hits: [] }]);
    expect(deps.buildSpy).not.toHaveBeenCalled();
    expect(deps.querySpy).not.toHaveBeenCalled();
  });
});
