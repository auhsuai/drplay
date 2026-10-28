// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileRemoteRoots,
  selectAuthoritativeRoots,
} from "./rootReconciliation";
import type { RootFolder } from "../../utils/rootFolders";
import { getAppConfig } from "../../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../../utils/apiClient";
import { captureError } from "../../utils/errorLog";

vi.mock("../../utils/driveApi", () => ({
  getAppConfig: vi.fn(),
  FOLDER_MIME: "application/vnd.google-apps.folder",
}));

vi.mock("../../utils/apiClient", () => ({
  getValidToken: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedGetAppConfig = vi.mocked(getAppConfig);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedFetchWithAuth = vi.mocked(fetchWithAuth);
const mockedCaptureError = vi.mocked(captureError);

type AppConfigReadResult = Awaited<ReturnType<typeof getAppConfig>>;

const foundConfig = (config: Record<string, unknown>): AppConfigReadResult => ({
  status: "found",
  config,
});

const failedConfig = (
  reason: "search" | "download" | "network" | "malformed" | "aborted",
): AppConfigReadResult => ({ status: "failed", reason });

function okFolderResponse(name: string): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        name,
        mimeType: "application/vnd.google-apps.folder",
      }),
  } as unknown as Response;
}

const local: RootFolder[] = [
  { id: "root-A", name: "A" },
  { id: "root-B", name: "B" },
];

function makeInput(overrides: {
  localRoots?: RootFolder[];
  isReInit?: boolean;
  cancelled?: boolean;
  userChanged?: boolean;
}) {
  const {
    localRoots = [],
    isReInit = false,
    cancelled = false,
    userChanged = false,
  } = overrides;
  return {
    signal: new AbortController().signal,
    localRoots,
    localUpdatedAt: 0,
    isReInit,
    isCancelled: () => cancelled,
    rootChangedByUser: () => userChanged,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetValidToken.mockResolvedValue("tok");
  mockedFetchWithAuth.mockResolvedValue(okFolderResponse("Live"));
});

describe("selectAuthoritativeRoots (pure)", () => {
  it("keeps the local list when the remote config is absent", () => {
    const result = selectAuthoritativeRoots({
      remoteConfig: null,
      localRoots: local,
      localUpdatedAt: 0,
    });

    expect(result.proposed).toEqual(local);
    expect(result.warnings).toEqual([]);
  });

  it("prefers a valid remote rootFolders list over the local one", () => {
    const result = selectAuthoritativeRoots({
      remoteConfig: {
        rootFolderId: "root-R",
        rootFolders: [{ id: "root-R", name: "Remote" }],
      },
      localRoots: local,
      localUpdatedAt: 0,
    });

    expect(result.proposed).toEqual([{ id: "root-R", name: "Remote" }]);
  });

  it("falls back to the legacy root id when the remote list is invalid", () => {
    const result = selectAuthoritativeRoots({
      remoteConfig: { rootFolderId: "legacy-1", rootFolders: [] },
      localRoots: local,
      localUpdatedAt: 0,
    });

    expect(result.proposed).toEqual([{ id: "legacy-1", name: "My Drive" }]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "config-root-folders-invalid",
    ]);
  });

  it("falls back to the local list when the remote document carries no root at all", () => {
    const result = selectAuthoritativeRoots({
      remoteConfig: {},
      localRoots: local,
      localUpdatedAt: 0,
    });

    expect(result.proposed).toEqual(local);
  });
});

describe("reconcileRemoteRoots outcome mapping", () => {
  it("found ⇒ resolved with the verified remote roots", async () => {
    mockedGetAppConfig.mockResolvedValue(
      foundConfig({
        rootFolderId: "root-A",
        rootFolders: [{ id: "root-A", name: "Stale" }],
      }),
    );

    const outcome = await reconcileRemoteRoots(makeInput({}));

    expect(outcome).toEqual({
      kind: "resolved",
      roots: [{ id: "root-A", name: "Live" }],
      rootChanged: true,
    });
  });

  it("missing ⇒ confirmed absence keeps today's local fallback", async () => {
    mockedGetAppConfig.mockResolvedValue({ status: "missing" });

    const outcome = await reconcileRemoteRoots(
      makeInput({ localRoots: local }),
    );

    // Same ids (no root change) but the verify stage refreshes real names —
    // exactly today's behaviour for a confirmed absence.
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.roots.map((root) => root.id)).toEqual(["root-A", "root-B"]);
    expect(outcome.rootChanged).toBe(false);
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("failed + local roots ⇒ keeps the local list offline (no verify, no gate)", async () => {
    mockedGetAppConfig.mockResolvedValue(failedConfig("network"));

    const outcome = await reconcileRemoteRoots(
      makeInput({ localRoots: local }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      roots: local,
      rootChanged: false,
    });
    // Unreachable remote must not be probed root-by-root.
    expect(mockedFetchWithAuth).not.toHaveBeenCalled();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useDrive",
        message: "config-read-failed: network",
        kind: "config-read-failed",
      }),
    );
  });

  it("failed + NO local roots ⇒ config-unavailable (never 'no roots configured')", async () => {
    mockedGetAppConfig.mockResolvedValue(failedConfig("malformed"));

    const outcome = await reconcileRemoteRoots(makeInput({ localRoots: [] }));

    expect(outcome).toEqual({ kind: "config-unavailable" });
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "config-read-failed: malformed",
        kind: "config-read-failed",
      }),
    );
  });

  it("!freshToken on a re-init ⇒ keep-previous (roots survive the blip)", async () => {
    mockedGetValidToken.mockResolvedValue(null);

    const outcome = await reconcileRemoteRoots(
      makeInput({ localRoots: local, isReInit: true }),
    );

    expect(outcome).toEqual({ kind: "keep-previous" });
    expect(mockedGetAppConfig).not.toHaveBeenCalled();
  });

  it("!freshToken on a first init ⇒ config-unavailable", async () => {
    mockedGetValidToken.mockResolvedValue(null);

    const outcome = await reconcileRemoteRoots(makeInput({}));

    expect(outcome).toEqual({ kind: "config-unavailable" });
  });

  it("cancellation wins before any config read", async () => {
    const outcome = await reconcileRemoteRoots(makeInput({ cancelled: true }));

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(mockedGetAppConfig).not.toHaveBeenCalled();
  });

  it("a user commit during the read wins over the remote config", async () => {
    mockedGetAppConfig.mockResolvedValue({ status: "missing" });

    const outcome = await reconcileRemoteRoots(
      makeInput({ localRoots: local, userChanged: true }),
    );

    expect(outcome).toEqual({ kind: "user-changed" });
  });
});
