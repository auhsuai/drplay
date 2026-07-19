// Regression tests for the "FLAC served with the wrong Content-Type" bug.
//
// Root cause: the proxy forwarded Google Drive's Content-Type (often
// application/octet-stream for FLAC) and the old frontend logic treated a
// successful HEAD probe (proxy serves the file) as proof of a "real format
// error", skipping perfectly playable tracks. A valid FLAC must NOT be treated
// as a definitive format error.
import { describe, it, expect } from "vitest";
import {
  decideDecodeFailure,
  isKnownDecodableExt,
  MEDIA_ERR_ABORTED,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_DECODE,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
} from "./streamError";

describe("decideDecodeFailure — FLAC / lossless regression", () => {
  it("FLAC (ext=flac) + HEAD ok + SRC_NOT_SUPPORTED is retried, not skipped", () => {
    const d = decideDecodeFailure({
      mediaErrorCode: MEDIA_ERR_SRC_NOT_SUPPORTED,
      headOk: true,
      ext: "flac",
    });
    expect(d.shouldRetryWithCorrectType).toBe(true);
    expect(d.isDefinitiveFormatError).toBe(false);
  });

  it("FLAC (ext=flac) + HEAD ok + DECODE is retried, not skipped", () => {
    const d = decideDecodeFailure({
      mediaErrorCode: MEDIA_ERR_DECODE,
      headOk: true,
      ext: "flac",
    });
    expect(d.shouldRetryWithCorrectType).toBe(true);
    expect(d.isDefinitiveFormatError).toBe(false);
  });

  it("MP3 (known decodable) + HEAD ok + decode error is retried", () => {
    const d = decideDecodeFailure({
      mediaErrorCode: MEDIA_ERR_SRC_NOT_SUPPORTED,
      headOk: true,
      ext: "mp3",
    });
    expect(d.shouldRetryWithCorrectType).toBe(true);
    expect(d.isDefinitiveFormatError).toBe(false);
  });

  it("OGG/OPUS (known decodable) + HEAD ok + decode error is retried", () => {
    expect(
      decideDecodeFailure({ mediaErrorCode: MEDIA_ERR_DECODE, headOk: true, ext: "ogg" }).shouldRetryWithCorrectType,
    ).toBe(true);
    expect(
      decideDecodeFailure({ mediaErrorCode: MEDIA_ERR_DECODE, headOk: true, ext: "opus" }).shouldRetryWithCorrectType,
    ).toBe(true);
  });

  it("unknown extension + HEAD ok + SRC_NOT_SUPPORTED is a definitive format error (skip)", () => {
    const d = decideDecodeFailure({
      mediaErrorCode: MEDIA_ERR_SRC_NOT_SUPPORTED,
      headOk: true,
      ext: "xyz",
    });
    expect(d.shouldRetryWithCorrectType).toBe(false);
    expect(d.isDefinitiveFormatError).toBe(true);
  });

  it("HEAD failed (file/transient problem) is neither retry-nor-format-error here", () => {
    const d = decideDecodeFailure({
      mediaErrorCode: MEDIA_ERR_SRC_NOT_SUPPORTED,
      headOk: false,
      ext: "flac",
    });
    expect(d.shouldRetryWithCorrectType).toBe(false);
    expect(d.isDefinitiveFormatError).toBe(false);
  });

  it("network/aborted errors are never format errors", () => {
    expect(
      decideDecodeFailure({ mediaErrorCode: MEDIA_ERR_NETWORK, headOk: true, ext: "flac" }).isDefinitiveFormatError,
    ).toBe(false);
    expect(
      decideDecodeFailure({ mediaErrorCode: MEDIA_ERR_ABORTED, headOk: true, ext: "flac" }).isDefinitiveFormatError,
    ).toBe(false);
  });

  it("isKnownDecodableExt handles casing and missing extension", () => {
    expect(isKnownDecodableExt("FLAC")).toBe(true);
    expect(isKnownDecodableExt("FlAc")).toBe(true);
    expect(isKnownDecodableExt(undefined)).toBe(false);
    expect(isKnownDecodableExt("bin")).toBe(false);
  });
});
