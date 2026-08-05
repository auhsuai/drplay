// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { initReactI18next } from "react-i18next";
import i18n from "i18next";
import enTranslation from "../../locales/en/translation.json";
import { ImageCropperModal } from "./ImageCropperModal";

vi.mock("react-easy-crop", async () => {
  const React = await import("react");
  function MockCropper(props: Record<string, unknown>) {
    const onCropComplete = props.onCropComplete as
      | ((area: unknown, pixels: unknown) => void)
      | undefined;
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
