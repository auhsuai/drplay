// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadButton } from "./UploadButton";
import { useDriveStore } from "../../store/driveStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("lucide-react", () => ({
  // CloudUpload is the canonical lucide export for "cloud-upload";
  // UploadCloud is the deprecated alias (removed in a future lucide major).
  CloudUpload: mocks.lucideCloudUpload,
}));

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  startUploads: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
  lucideCloudUpload: vi.fn((props: { className?: string }) => {
    void props;
    return null;
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../utils/uploadManager", () => ({
  startUploads: mocks.startUploads,
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));

const AUDIO_FILTER = {
  name: "upload.audio_files",
  extensions: ["mp3", "flac", "wav", "m4a", "ogg", "aac", "opus"],
};
const BUTTON_TITLE = "upload.button_title";
const MENU_FILE_LABEL = "upload.upload_file";
const MENU_FOLDER_LABEL = "upload.upload_folder";

function openButton(): HTMLElement {
  return screen.getByTitle(BUTTON_TITLE);
}

function selectFileOption() {
  fireEvent.click(openButton());
  fireEvent.click(screen.getByText(MENU_FILE_LABEL));
}

function selectFolderOption() {
  fireEvent.click(openButton());
  fireEvent.click(screen.getByText(MENU_FOLDER_LABEL));
}

describe("UploadButton", () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.startUploads.mockReset();
    mocks.showErrorToast.mockReset();
    mocks.captureError.mockReset();
    mocks.lucideCloudUpload.mockReset();
    useDriveStore.setState({ currentFolderId: "root" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders a button with the i18n title when a token is present", () => {
    render(<UploadButton token="tok-1" />);
    expect(openButton()).toBeTruthy();
  });

  it("renders the CloudUpload icon (cloud-arrow-up) at w-5 h-5", () => {
    render(<UploadButton token="tok-1" />);
    expect(mocks.lucideCloudUpload).toHaveBeenCalledTimes(1);
    const firstCall = mocks.lucideCloudUpload.mock.calls[0];
    if (firstCall === undefined)
      throw new Error("expected lucideCloudUpload call");
    const props = firstCall[0];
    expect(props.className).toBe("w-5 h-5");
  });

  it("does not render when token is null", () => {
    render(<UploadButton token={null} />);
    expect(screen.queryByTitle(BUTTON_TITLE)).toBeNull();
  });

  it("does not render when token is undefined", () => {
    render(<UploadButton />);
    expect(screen.queryByTitle(BUTTON_TITLE)).toBeNull();
  });

  it("opens a menu with the two upload options on click", () => {
    render(<UploadButton token="tok-1" />);
    fireEvent.click(openButton());
    expect(screen.getByText(MENU_FILE_LABEL)).toBeTruthy();
    expect(screen.getByText(MENU_FOLDER_LABEL)).toBeTruthy();
  });

  it("uploads multiple files with the audio filter into the current folder", async () => {
    useDriveStore.setState({ currentFolderId: "folder-1" });
    mocks.open.mockResolvedValue(["C:\\Music\\a.mp3", "C:\\Music\\b.flac"]);
    render(<UploadButton token="tok-1" />);

    selectFileOption();

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledWith({
        directory: false,
        multiple: true,
        filters: [AUDIO_FILTER],
      });
    });
    await waitFor(() => {
      expect(mocks.startUploads).toHaveBeenCalledTimes(1);
    });
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "folder-1",
          diskPath: "C:\\Music\\a.mp3",
        },
        {
          name: "b.flac",
          isFolder: false,
          parentId: "folder-1",
          diskPath: "C:\\Music\\b.flac",
        },
      ],
      "tok-1",
    );
  });

  it("normalizes a single string result from a multiple file dialog into one seed", async () => {
    mocks.open.mockResolvedValue("C:\\Music\\only.mp3");
    render(<UploadButton token="tok-1" />);

    selectFileOption();

    await waitFor(() => {
      expect(mocks.startUploads).toHaveBeenCalledTimes(1);
    });
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "only.mp3",
          isFolder: false,
          parentId: "root",
          diskPath: "C:\\Music\\only.mp3",
        },
      ],
      "tok-1",
    );
  });

  it("uploads a single folder into the current folder", async () => {
    mocks.open.mockResolvedValue("C:\\Music\\Album");
    render(<UploadButton token="tok-1" />);

    selectFolderOption();

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledWith({ directory: true });
    });
    await waitFor(() => {
      expect(mocks.startUploads).toHaveBeenCalledTimes(1);
    });
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "Album",
          isFolder: true,
          parentId: "root",
          diskPath: "C:\\Music\\Album",
        },
      ],
      "tok-1",
    );
  });

  it("strips a trailing separator from the folder path when deriving its name", async () => {
    mocks.open.mockResolvedValue("C:\\Music\\Album\\");
    render(<UploadButton token="tok-1" />);

    selectFolderOption();

    await waitFor(() => {
      expect(mocks.startUploads).toHaveBeenCalledTimes(1);
    });
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "Album",
          isFolder: true,
          parentId: "root",
          diskPath: "C:\\Music\\Album\\",
        },
      ],
      "tok-1",
    );
  });

  it("does not start uploads when the user cancels the dialog", async () => {
    mocks.open.mockResolvedValue(null);
    render(<UploadButton token="tok-1" />);

    selectFileOption();

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalled();
    });
    expect(mocks.startUploads).not.toHaveBeenCalled();
  });

  it("shows an error toast and logs when the file dialog rejects", async () => {
    mocks.open.mockRejectedValue(new Error("dialog exploded"));
    render(<UploadButton token="tok-1" />);

    selectFileOption();

    await waitFor(() => {
      expect(mocks.showErrorToast).toHaveBeenCalledWith("upload.upload_error");
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "UploadButton", level: "error" }),
    );
  });

  it("shows an error toast and logs when the folder dialog rejects", async () => {
    mocks.open.mockRejectedValue(new Error("dialog exploded"));
    render(<UploadButton token="tok-1" />);

    selectFolderOption();

    await waitFor(() => {
      expect(mocks.showErrorToast).toHaveBeenCalledWith("upload.upload_error");
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "UploadButton" }),
    );
  });

  it("closes the menu after choosing an option", async () => {
    mocks.open.mockResolvedValue(null);
    render(<UploadButton token="tok-1" />);

    selectFileOption();

    await waitFor(() => {
      expect(screen.queryByText(MENU_FILE_LABEL)).toBeNull();
    });
  });

  it("closes the menu on an outside mousedown", () => {
    render(<UploadButton token="tok-1" />);
    fireEvent.click(openButton());
    expect(screen.getByText(MENU_FILE_LABEL)).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText(MENU_FILE_LABEL)).toBeNull();
  });

  it("closes the menu on Escape", () => {
    render(<UploadButton token="tok-1" />);
    fireEvent.click(openButton());
    expect(screen.getByText(MENU_FILE_LABEL)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(MENU_FILE_LABEL)).toBeNull();
  });

  it("does not propagate the button click to the sidebar header", () => {
    const onHeaderClick = vi.fn();
    render(
      <div
        role="button"
        tabIndex={0}
        onClick={onHeaderClick}
        onKeyDown={onHeaderClick}
      >
        <UploadButton token="tok-1" />
      </div>,
    );
    fireEvent.click(openButton());
    expect(onHeaderClick).not.toHaveBeenCalled();
  });
});
