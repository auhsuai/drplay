// Typed error taxonomy for the Drive range-fetch pipeline (extracted from
// driveRangeTokenizer.ts, which re-exports every class so consumers keep
// importing from "./driveRangeTokenizer"). Pure Error subclasses with zero
// dependencies — this module cannot form an import cycle with the tokenizer
// or any caller. Semantics recap (usage lives in driveRangeTokenizer.ts):
// - SizeUnknownError: size <= 0 / non-finite — metadata fetch is skipped.
// - RangeNotSupportedError: server ignored the Range request (non-206).
// - BudgetExceededError: per-file fetch budget exceeded.
// - RangeFetchNetworkError: transient network/timeout/throttle failure —
//   callers treat it as retryable on the next mount, never pinning a
//   placeholder version.

export class SizeUnknownError extends Error {
  constructor(message = "File size is unknown; metadata fetch is skipped") {
    super(message);
    this.name = "SizeUnknownError";
  }
}

export class RangeNotSupportedError extends Error {
  constructor(status: number) {
    super(`Server did not honor the Range request (status ${String(status)})`);
    this.name = "RangeNotSupportedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(loadedBytes: number, capBytes: number) {
    super(
      `Range fetch budget exceeded (loaded ${String(loadedBytes)} bytes, cap ${String(capBytes)} bytes)`,
    );
    this.name = "BudgetExceededError";
  }
}

export class RangeFetchNetworkError extends Error {
  readonly kind: "network" | "timeout";
  constructor(kind: "network" | "timeout", message: string) {
    super(message);
    this.name = "RangeFetchNetworkError";
    this.kind = kind;
  }
}
