// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureError } from "./errorLog";
import { copyToClipboard } from "./copyToClipboard";

vi.mock("./errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

const tauriWriteTextMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: tauriWriteTextMock,
}));

const mockedCaptureError = vi.mocked(captureError);
const mockedTauriWriteText = vi.mocked(tauriWriteTextMock);

const SECRET_TEXT = "SECRET-TOKEN-abc123";

function stubWebClipboard(
  writeText: ((text: string) => Promise<void>) | undefined,
): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

function stubExecCommand(
  impl: ((commandId: string) => boolean) | undefined,
): void {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: impl,
  });
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTauriWriteText.mockResolvedValue(undefined);
    stubWebClipboard(undefined);
    stubExecCommand(undefined);
    document.body.innerHTML = "";
  });

  it("tauri success → true without touching fallbacks or logging", async () => {
    const webWrite = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const execMock = vi
      .fn<(commandId: string) => boolean>()
      .mockReturnValue(true);
    stubWebClipboard(webWrite);
    stubExecCommand(execMock);

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(true);
    expect(mockedTauriWriteText).toHaveBeenCalledWith(SECRET_TEXT);
    expect(webWrite).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("tauri fails + web Clipboard API works → true via fallback, no log", async () => {
    mockedTauriWriteText.mockRejectedValue(new Error("tauri-denied"));
    const webWrite = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    stubWebClipboard(webWrite);

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(true);
    expect(webWrite).toHaveBeenCalledWith(SECRET_TEXT);
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("tauri fails + web clipboard missing + execCommand works → true and temp element cleaned up", async () => {
    mockedTauriWriteText.mockRejectedValue(new Error("tauri-denied"));
    stubWebClipboard(undefined);
    const execMock = vi
      .fn<(commandId: string) => boolean>()
      .mockReturnValue(true);
    stubExecCommand(execMock);

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("all backends fail → false + single warn without clipboard content", async () => {
    mockedTauriWriteText.mockRejectedValue(new Error("tauri-denied"));
    stubWebClipboard(
      vi
        .fn<(text: string) => Promise<void>>()
        .mockRejectedValue(new Error("web-denied")),
    );
    stubExecCommand(
      vi.fn<(commandId: string) => boolean>().mockReturnValue(false),
    );

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(false);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    const call = mockedCaptureError.mock.calls[0]?.[0];
    expect(call?.level).toBe("warn");
    expect(call?.source).toBe("copyToClipboard");
    expect(String(call?.message)).not.toContain(SECRET_TEXT);
  });

  it("execCommand throws → false + warn without clipboard content", async () => {
    mockedTauriWriteText.mockRejectedValue(new Error("tauri-denied"));
    stubWebClipboard(
      vi
        .fn<(text: string) => Promise<void>>()
        .mockRejectedValue(new Error("web-denied")),
    );
    stubExecCommand(
      vi.fn<(commandId: string) => boolean>().mockImplementation(() => {
        throw new Error("exec-denied");
      }),
    );

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(false);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    const call = mockedCaptureError.mock.calls[0]?.[0];
    expect(String(call?.message)).not.toContain(SECRET_TEXT);
  });

  it("no web clipboard and no execCommand → false + warn", async () => {
    mockedTauriWriteText.mockRejectedValue(new Error("tauri-denied"));
    stubWebClipboard(undefined);
    stubExecCommand(undefined);

    await expect(copyToClipboard(SECRET_TEXT)).resolves.toBe(false);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
  });
});
