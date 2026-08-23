// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { NewFolderModal } from "./NewFolderModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

// Contract under test: onCreate is awaited as a REAL promise — resolution
// clears the input, rejection keeps the modal open with the typed name so the
// user can retry without retyping (the hook owns the error toast/capture).
describe("NewFolderModal input retention on failed create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderModal(onCreate: (name: string) => Promise<void>) {
    return render(
      <NewFolderModal
        isOpen
        onClose={vi.fn()}
        onCreate={onCreate}
        isCreating={false}
      />,
    );
  }

  function typeName(value: string) {
    fireEvent.change(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
      {
        target: { value },
      },
    );
  }

  async function submit() {
    fireEvent.click(screen.getByRole("button", { name: "menu.create" }));
    // Flush the microtask chain the async handler resolves through.
    await act(async () => {});
  }

  it("clears the input when onCreate resolves (real success)", async () => {
    renderModal(vi.fn(() => Promise.resolve()));
    typeName("Movies");

    await submit();

    expect(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
    ).toHaveValue("");
  });

  it("keeps the typed name when onCreate rejects so the user can retry", async () => {
    renderModal(vi.fn(() => Promise.reject(new Error("create failed"))));
    typeName("Movies");

    await submit();

    // The failure path must leave the name in place for a retry — and must
    // not crash via an unhandled rejection escaping handleCreate.
    expect(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
    ).toHaveValue("Movies");
    expect(screen.getByText("drive.new_folder_title")).not.toBeNull();
  });
});
