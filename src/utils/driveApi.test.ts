import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backoffDelay, driveFetch } from "./driveApi";

// Mock the auth-bound transport so we can simulate Drive API responses and
// exercise driveFetch's retry/backoff path without real network calls.
vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from "./apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);

function makeResponse(status: number): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: { get: () => null },
  } as unknown as Response;
}

describe("backoffDelay", () => {
  it("honors numeric Retry-After in seconds (capped at MAX_DELAY_MS)", () => {
    expect(backoffDelay(0, "5")).toBe(5000);
    expect(backoffDelay(0, "100")).toBe(32000); // 100s > 32s cap
  });

  it("honors Retry-After as an HTTP date when in the future (capped)", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const d = backoffDelay(0, future);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(32000);
  });

  it("ignores an already-expired Retry-After date and falls back to exp backoff", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const d = backoffDelay(0, past);
    expect(d).toBeGreaterThanOrEqual(1000); // exponential base at attempt 0
  });

  it("uses exponential backoff + jitter bounded at base for attempt 0", () => {
    const d = backoffDelay(0);
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1500); // 1000 + up to 50% jitter
  });

  it("caps exponential backoff at MAX_DELAY_MS", () => {
    expect(backoffDelay(5)).toBe(32000);
    expect(backoffDelay(10)).toBe(32000);
  });
});

describe("driveFetch retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries on 429 then 503 and returns the eventual 200", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(200);
  });

  it("retries on a network error and returns the eventual 200", async () => {
    mockedFetch
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("does NOT retry a non-retryable 4xx and returns it immediately", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(404));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });
});
