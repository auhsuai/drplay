// Typed fetch-error classes for the DriveRangeTokenizer (refactor: extracted
// verbatim from driveRangeTokenizer.ts — same messages, same names, re-exported
// by the tokenizer facade so consumer imports keep resolving unchanged).
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
