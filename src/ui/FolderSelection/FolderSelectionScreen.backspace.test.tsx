// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  FolderSelectionScreen,
  MOVE_PICKER_OPEN_ATTR,
} from "./FolderSelectionScreen";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Folder: Stub,
    ArrowLeft: Stub,
    HardDrive: Stub,
    Check: Stub,
    Search: Stub,
    LoaderCircle: Stub,
    X: Stub,
  };
});

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));
vi.mock("../../utils/simpleToast", () => ({ showErrorToast: vi.fn() }));

const { useFolderPickerMock } = vi.hoisted(() => ({
  useFolderPickerMock: vi.fn(),
}));

vi.mock("./useFolderPicker", () => ({
  useFolderPicker: useFolderPickerMock,
}));

type PickerState = {
  isLoading: boolean;
  searchQuery: string;
  setSearchQuery: () => void;
  filteredFolders: { id: string; name: string }[];
  apiSearchResults: { id: string; name: string }[];
  isSearchingApi: boolean;
  currentFolderId: string;
  currentFolderName: string;
  folderHistory: { id: string; name: string }[];
  handleOpenFolder: () => void;
  handleBack: () => void;
  handleBreadcrumbClick: () => void;
  searchInputRef: { current: null };
};

function makePickerState(over: Partial<PickerState> = {}): PickerState {
  return {
    isLoading: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredFolders: [],
    apiSearchResults: [],
    isSearchingApi: false,
    currentFolderId: ROOT_FOLDER_ID,
    currentFolderName: "My Drive",
    folderHistory: [],
    handleOpenFolder: vi.fn(),
    handleBack: vi.fn(),
    handleBreadcrumbClick: vi.fn(),
    searchInputRef: { current: null },
    ...over,
  };
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    token: "tok",
    onSelectFolder: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

function pressBackspace(init: Record<string, unknown> = {}) {
  fireEvent.keyDown(window, { key: "Backspace", ...init });
}

describe("FolderSelectionScreen Backspace (slice B)", () => {
  beforeEach(() => {
    useFolderPickerMock.mockClear();
    useFolderPickerMock.mockReturnValue(makePickerState());
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("sets the move-picker-open flag while mounted and clears it on unmount", () => {
    expect(document.body.hasAttribute(MOVE_PICKER_OPEN_ATTR)).toBe(false);
    const { unmount } = render(<FolderSelectionScreen {...baseProps()} />);
    expect(document.body.getAttribute(MOVE_PICKER_OPEN_ATTR)).toBe("true");
    unmount();
    expect(document.body.hasAttribute(MOVE_PICKER_OPEN_ATTR)).toBe(false);
  });

  it("Backspace with picker history steps back inside the picker", () => {
    const onCancel = vi.fn();
    const picker = makePickerState({
      folderHistory: [{ id: "parent", name: "Parent" }],
    });
    useFolderPickerMock.mockReturnValue(picker);
    render(<FolderSelectionScreen {...baseProps({ onCancel })} />);

    pressBackspace();

    expect(picker.handleBack).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Backspace at the picker root closes the picker (onCancel)", () => {
    const onCancel = vi.fn();
    const picker = makePickerState({
      folderHistory: [],
      currentFolderId: ROOT_FOLDER_ID,
    });
    useFolderPickerMock.mockReturnValue(picker);
    render(<FolderSelectionScreen {...baseProps({ onCancel })} />);

    pressBackspace();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(picker.handleBack).not.toHaveBeenCalled();
  });

  it("Backspace below the root with empty history navigates to the parent instead of closing", () => {
    const onCancel = vi.fn();
    const picker = makePickerState({
      folderHistory: [],
      currentFolderId: "sub-folder",
    });
    useFolderPickerMock.mockReturnValue(picker);
    render(
      <FolderSelectionScreen
        {...baseProps({ onCancel, appRootFolder: ROOT_FOLDER_ID })}
      />,
    );

    pressBackspace();

    expect(picker.handleBack).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Backspace inside the picker search input is a no-op and keeps the text", () => {
    const onCancel = vi.fn();
    const picker = makePickerState({
      searchQuery: "docs",
      folderHistory: [{ id: "parent", name: "Parent" }],
    });
    useFolderPickerMock.mockReturnValue(picker);
    render(<FolderSelectionScreen {...baseProps({ onCancel })} />);
    const searchInput = document.querySelector("input");
    if (searchInput === null) throw new Error("expected picker search input");
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    pressBackspace();

    expect(picker.handleBack).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(searchInput).toHaveValue("docs");
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    "Backspace with modifier (%o) is a no-op",
    (mod) => {
      const onCancel = vi.fn();
      const picker = makePickerState({
        folderHistory: [{ id: "parent", name: "Parent" }],
      });
      useFolderPickerMock.mockReturnValue(picker);
      render(<FolderSelectionScreen {...baseProps({ onCancel })} />);

      pressBackspace(mod);

      expect(picker.handleBack).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    },
  );

  it("Backspace while loading is a no-op", () => {
    const onCancel = vi.fn();
    const picker = makePickerState({
      isLoading: true,
      folderHistory: [{ id: "parent", name: "Parent" }],
    });
    useFolderPickerMock.mockReturnValue(picker);
    render(<FolderSelectionScreen {...baseProps({ onCancel })} />);

    pressBackspace();

    expect(picker.handleBack).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
