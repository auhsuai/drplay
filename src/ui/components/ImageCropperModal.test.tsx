// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { initReactI18next } from "react-i18next";
import i18n from "i18next";
import enTranslation from "../../locales/en/translation.json";
import { ImageCropperModal } from "./ImageCropperModal";

const { captureErrorMock } = vi.hoisted(() => ({
  captureErrorMock: vi.fn<
    (input: {
      level?: string;
      source: string;
      message: string;
    }) => Promise<void>
  >(() => Promise.resolve()),
}));
vi.mock("../../utils/errorLog", () => ({ captureError: captureErrorMock }));

const { showErrorToastMock } = vi.hoisted(() => ({
  showErrorToastMock: vi.fn(),
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: showErrorToastMock,
}));

vi.mock("react-easy-crop", async () => {
  const React = await import("react");
  function MockCropper(props: Record<string, unknown>) {
    const onCropComplete = props.onCropComplete as
      ((area: unknown, pixels: unknown) => void) | undefined;
    React.useEffect(() => {
      onCropComplete?.(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 100, height: 100 },
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mock fires once on mount, mirroring the first crop of the real Cropper
    }, []);
    return React.createElement("div", { "data-testid": "mock-cropper" });
  }
  return { default: MockCropper };
});

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: enTranslation } },
});

function baseProps(
  over: Partial<Parameters<typeof ImageCropperModal>[0]> = {},
) {
  return {
    imageSrc: "data:image/png;base64,AAAA",
    onClose: vi.fn(),
    onSave: vi.fn(),
    ...over,
  };
}

describe("ImageCropperModal WAI-ARIA APG dialog semantics", () => {
  afterEach(() => {
    cleanup();
  });

  it('exposes role="dialog" aria-modal="true" aria-labelledby pointing to visible title', () => {
    const { container } = render(<ImageCropperModal {...baseProps()} />);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("cropper-title");
    expect(container.querySelector("#cropper-title")).not.toBeNull();
  });

  it("names the icon-only close button via aria-label", () => {
    render(<ImageCropperModal {...baseProps()} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("closes on Escape keydown", () => {
    const onClose = vi.fn();
    render(<ImageCropperModal {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    const { container } = render(<ImageCropperModal {...baseProps()} />);
    expect(document.activeElement).toBe(
      container.querySelector('[role="dialog"]'),
    );
  });

  it("restores focus to the trigger element on unmount", () => {
    document.body.innerHTML = '<button id="trigger">Open</button>';
    const trigger = document.getElementById("trigger") as HTMLElement;
    trigger.focus();
    const { unmount } = render(<ImageCropperModal {...baseProps()} />);
    unmount();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab: from the last focusable control focus wraps back to the first", () => {
    render(<ImageCropperModal {...baseProps()} />);
    const saveButton = screen.getByRole("button", { name: /Lưu|Save/ });
    saveButton.focus();

    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
  });

  it("traps Shift+Tab: from the first focusable control focus wraps to the last", () => {
    render(<ImageCropperModal {...baseProps()} />);
    screen.getByRole("button", { name: "Close" }).focus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Lưu|Save/ }),
    );
  });

  it("traps Shift+Tab from the dialog container (tabIndex -1) to the last control", () => {
    const { container } = render(<ImageCropperModal {...baseProps()} />);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    dialog?.focus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Lưu|Save/ }),
    );
  });
});

describe("ImageCropperModal close guards while processing", () => {
  beforeEach(() => {
    class PendingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
    }
    vi.stubGlobal("Image", PendingImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  function startSave() {
    fireEvent.click(screen.getByRole("button", { name: /Lưu|Save/ }));
  }

  it("blocks overlay, X and Cancel from closing while save is processing", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageCropperModal {...baseProps({ onClose })} />,
    );
    startSave();

    const overlay = container.querySelector(".fixed.inset-0") as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveProperty("disabled", true);
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toHaveProperty("disabled", true);
    fireEvent.click(cancelButton);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape while save is processing", () => {
    const onClose = vi.fn();
    render(<ImageCropperModal {...baseProps({ onClose })} />);
    startSave();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ImageCropperModal crop failure recovery", () => {
  beforeEach(() => {
    captureErrorMock.mockClear();
    showErrorToastMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("settles a draw failure with a named rejection, resets isProcessing and stays closable", async () => {
    class AutoLoadImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", AutoLoadImage);
    const drawImage = vi.fn(() => {
      throw new Error("draw boom");
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<ImageCropperModal {...baseProps({ onClose, onSave })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Lưu|Save/ }));
      // Flush the image-load -> draw -> rejection microtask chain inside act
      // so the recovery (toast + isProcessing reset) lands before asserting.
      await Promise.resolve();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(showErrorToastMock).toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "ImageCropperModal",
      }),
    );
    const firstCall = captureErrorMock.mock.calls[0]?.[0];
    expect(firstCall?.message).toContain("crop-draw-failed: draw boom");
    // isProcessing was reset by the finally path: Save re-enabled, Escape works.
    expect(screen.getByRole("button", { name: /Lưu|Save/ })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects a load failure with a named Error instead of the raw Event ([object Event] log)", async () => {
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
    }
    vi.stubGlobal("Image", FailingImage);

    render(<ImageCropperModal {...baseProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Lưu|Save/ }));
      await Promise.resolve();
    });

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "ImageCropperModal",
      }),
    );
    const firstCall = captureErrorMock.mock.calls[0]?.[0];
    expect(firstCall?.message).toContain("crop-image-load-failed");
    expect(showErrorToastMock).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Lưu|Save/ })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
