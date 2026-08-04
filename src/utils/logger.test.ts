import { describe, it, expect } from "vitest";
import { sanitizeString, sanitizeArg } from "./logger";

describe("logger sanitizeString", () => {
  it("redacts local proxy link with id → [REDACTED_LINK]", () => {
    const input =
      "http://127.0.0.1:62216/stream?id=1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp&ext=mp3";
    expect(sanitizeString(input)).toBe("[REDACTED_LINK]");
  });

  it("redacts googleapis file url → [REDACTED_LINK]", () => {
    const input =
      "https://www.googleapis.com/drive/v3/files/1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp?alt=media";
    expect(sanitizeString(input)).toBe("[REDACTED_LINK]");
  });

  it("redacts ?id=xxx → ?id=[REDACTED_ID]", () => {
    expect(sanitizeString("?id=1RoFd1kOvoIn")).toBe("?id=[REDACTED_ID]");
  });

  it("redacts access_token=xxx → [REDACTED_TOKEN]", () => {
    expect(sanitizeString("access_token=ya29.secretToken")).toBe(
      "[REDACTED_TOKEN]",
    );
    expect(sanitizeString("?access_token=ya29.secretToken")).toBe(
      "[REDACTED_TOKEN]",
    );
  });

  it("redacts Bearer xxx → Bearer [REDACTED_TOKEN]", () => {
    expect(sanitizeString("Bearer eyJhbGciOiJIUzI1NiIs")).toBe(
      "Bearer [REDACTED_TOKEN]",
    );
  });
});

describe("logger sanitizeArg", () => {
  it("redacts Error object message", () => {
    const err = new Error(
      "fetch failed: http://127.0.0.1:62216/stream?id=1RoFd1kOvoIn&ext=mp3",
    );
    // sanitizeArg returns unknown (typed pass-through); cast for the
    // assertions below. (minimal edit required for tsc after the
    // no-explicit-any cleanup — the test-file lint round may rework this.)
    const san = sanitizeArg(err) as Error;
    expect(san).toBeInstanceOf(Error);
    expect(san.message).toBe("fetch failed: [REDACTED_LINK]");
    expect(san.name).toBe("Error");
  });

  it("redacts nested object values", () => {
    const obj = {
      url: "http://127.0.0.1:62216/x?id=abc",
      token: "Bearer xyz.abc.def",
    };
    const san = sanitizeArg(obj) as Record<string, unknown>;
    expect(san.url).toBe("[REDACTED_LINK]");
    expect(san.token).toBe("Bearer [REDACTED_TOKEN]");
  });

  it("returns primitives untouched when not sensitive", () => {
    expect(sanitizeArg(42)).toBe(42);
    expect(sanitizeArg("hello world")).toBe("hello world");
  });
});

describe("logger sanitizeString — upgrade redaction patterns", () => {
  it("redacts refresh_token=xxx → [REDACTED_TOKEN]", () => {
    expect(sanitizeString("refresh_token=abc.def-123")).toBe(
      "[REDACTED_TOKEN]",
    );
    expect(sanitizeString("?refresh_token=abc.def")).toBe("[REDACTED_TOKEN]");
  });

  it("redacts token=xxx → [REDACTED_TOKEN]", () => {
    expect(sanitizeString("token=secret123")).toBe("[REDACTED_TOKEN]");
    expect(sanitizeString("?token=secret123")).toBe("[REDACTED_TOKEN]");
  });

  it("redacts upload_id=xxx value", () => {
    expect(sanitizeString("upload_id=abc123")).toBe("upload_id=[REDACTED_ID]");
    expect(sanitizeString("upload_id=abc123")).not.toContain("abc123");
  });

  it("redacts api_key / api-key / apikey → [REDACTED_TOKEN]", () => {
    expect(sanitizeString("api_key=abc123")).toBe("[REDACTED_TOKEN]");
    expect(sanitizeString("api-key=abc123")).toBe("[REDACTED_TOKEN]");
    expect(sanitizeString("?apikey=abc123")).toBe("[REDACTED_TOKEN]");
  });

  it("redacts lowercase bearer → Bearer [REDACTED_TOKEN]", () => {
    expect(sanitizeString("bearer xyz.abc")).toBe("Bearer [REDACTED_TOKEN]");
  });

  it("redacts Authorization header → Authorization: [REDACTED_TOKEN]", () => {
    expect(sanitizeString("Authorization: Bearer abc123")).toBe(
      "Authorization: [REDACTED_TOKEN]",
    );
    expect(sanitizeString("authorization: abc123")).toBe(
      "Authorization: [REDACTED_TOKEN]",
    );
  });
});

describe("logger sanitizeString — Drive id-key redaction", () => {
  it("redacts driveFileId= value", () => {
    expect(sanitizeString("driveFileId=abc123")).toBe("[REDACTED_ID]");
    expect(sanitizeString("driveFileId=abc123")).not.toContain("abc123");
  });

  it("redacts dbId= value", () => {
    expect(sanitizeString("dbId=xyz_1")).toBe("[REDACTED_ID]");
    expect(sanitizeString("dbId=xyz_1")).not.toContain("xyz_1");
  });

  it("redacts folder= value", () => {
    expect(sanitizeString("folder=root")).toBe("[REDACTED_ID]");
    expect(sanitizeString("folder=root")).not.toContain("root");
  });

  it("regression: id= still redacted as before", () => {
    expect(sanitizeString("id=abc")).toBe("id=[REDACTED_ID]");
    expect(sanitizeString("?id=abc")).toBe("?id=[REDACTED_ID]");
  });
});

describe("logger sanitizeArg — upgrade circular handling", () => {
  it("does not leak raw circular object containing a secret", () => {
    const circular: Record<string, unknown> = { payload: "Bearer supersecret" };
    circular.self = circular;
    const san = sanitizeArg(circular);
    expect(san).toBe("[REDACTED_UNSERIALIZABLE]");
    expect(String(san)).not.toContain("supersecret");
  });
});
