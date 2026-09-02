import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyWorkerError,
  logWorkerError,
  WorkerAbortError,
} from "./workerError";

// workerError.ts uses the canonical sanitizeString now living in errorLog —
// keep the real one, mock only captureError (same pattern as apiClient.test.ts).
vi.mock("../utils/errorLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/errorLog")>();
  return {
    ...actual,
    captureError: vi.fn().mockResolvedValue(undefined),
  };
});

import { captureError } from "../utils/errorLog";

describe("classifyWorkerError", () => {
  it("classifies an AbortSignal.timeout rejection as timeout", () => {
    const err = new Error("boom");
    err.name = "TimeoutError";
    expect(classifyWorkerError(err)).toBe("timeout");
  });

  it("classifies a user/worker abort as abort", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(classifyWorkerError(err)).toBe("abort");
  });

  it("classifies a malformed JSON body as parse", () => {
    expect(classifyWorkerError(new SyntaxError("Unexpected token"))).toBe(
      "parse",
    );
  });

  it("classifies a network failure (fetch TypeError) as network", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyWorkerError(err)).toBe("network");
  });

  it("treats an unrelated TypeError as unknown", () => {
    expect(
      classifyWorkerError(new TypeError("cannot read property of undefined")),
    ).toBe("unknown");
  });

  it("treats non-Error throwables as unknown", () => {
    expect(classifyWorkerError("just a string")).toBe("unknown");
    expect(classifyWorkerError(null)).toBe("unknown");
    expect(classifyWorkerError(undefined)).toBe("unknown");
  });
});

describe("WorkerAbortError", () => {
  it("is an Error with a recognizable name and is instanceof Error", () => {
    const err = new WorkerAbortError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkerAbortError");
  });
});

describe("logWorkerError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes module, timestamp and classified kind in the line", () => {
    logWorkerError(
      "proSync/files",
      { status: 500 },
      new Error("server down"),
      "error",
    );
    expect(captureError).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.level).toBe("error");
    expect(callArg.source).toBe("proSync/files");
    expect(callArg.message).toMatch(/\[proSync\/files\] unknown: server down/);
    expect(callArg.message).toMatch(/status=500/);
    expect(callArg.message).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts auth tokens and file ids from the message", () => {
    const err = new Error(
      "request failed with Bearer ya29.secret-token and ?id=1RoFd1kOvoIn",
    );
    logWorkerError("scanner/list", {}, err, "error");
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.message).not.toContain("ya29.secret-token");
    expect(callArg.message).toContain("[REDACTED_TOKEN]");
    expect(callArg.message).toContain("id=[REDACTED_ID]");
  });

  it("does not leak a raw token passed via context", () => {
    logWorkerError(
      "scanner/list",
      { token: "ya29.leaky" },
      new Error("oops"),
      "warn",
    );
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.message).not.toContain("ya29.leaky");
  });

  it("uses warn level for non-error severity", () => {
    logWorkerError(
      "scanner/cache",
      { fileId: "abc" },
      new Error("miss"),
      "warn",
    );
    expect(captureError).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    expect(firstCall[0].level).toBe("warn");
  });

  it("masks a Google-style refresh_token value (prefix-slash + padding)", () => {
    const err = new Error("refresh failed: refresh_token=1//secret==");
    logWorkerError("auth/refresh", {}, err, "error");
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    expect(firstCall[0].message).not.toContain("secret");
    expect(firstCall[0].message).toContain("[REDACTED_TOKEN]");
  });

  it("masks id values containing slash/plus/padding via message and context", () => {
    const err = new Error(
      "fetch failed for fileId=1RoF/abc+def== and ?id=1//xyz-_=",
    );
    logWorkerError("scanner/get", { fileId: "1//abc==" }, err, "error");
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    expect(firstCall[0].message).not.toContain("1RoF");
    expect(firstCall[0].message).not.toContain("+def==");
    expect(firstCall[0].message).not.toContain("//xyz");
    expect(firstCall[0].message).not.toContain("//abc==");
    expect(firstCall[0].message).toContain("[REDACTED_ID]");
  });
});
