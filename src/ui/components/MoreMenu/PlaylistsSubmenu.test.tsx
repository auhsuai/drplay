// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { TFunction } from "i18next";
import { PlaylistsSubmenu } from "./PlaylistsSubmenu";
import type { Playlist } from "../../../utils/playlists";
import en from "../../../locales/en/translation.json";

// react-i18next is not initialized in the node test env (i18n.ts touches
// localStorage at import time); t is passed as a prop, so a minimal TFunction
// backed by the real en resources keeps asserted UI strings in sync.
const t = ((key: string, fallback?: string) => {
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return fallback ?? "";
    }
  }
  return (typeof acc === "string" ? acc : fallback) ?? "";
}) as unknown as TFunction;

function makePlaylist(id: string, name: string): Playlist {
  return { id, userEmail: "me@example.com", name, createdAt: 1, tracks: [] };
}

function renderSubmenu(playlists: Playlist[], query: string) {
  render(
    <PlaylistsSubmenu
      showPlaylistsSubmenu={true}
      playlistSearchQuery={query}
      setPlaylistSearchQuery={vi.fn()}
      playlistCurrentPage={1}
      setPlaylistCurrentPage={vi.fn()}
      playlistSubmenuOpenLeft={false}
      playlists={playlists}
      onAddToPlaylist={vi.fn()}
      t={t}
    />,
  );
}

describe("PlaylistsSubmenu search filter", () => {
  afterEach(() => {
    cleanup();
  });

  it("filters by plain playlist name", () => {
    renderSubmenu(
      [
        makePlaylist("p1", "Chill Vibes"),
        makePlaylist("p2", "Party Mix"),
        makePlaylist("p3", "Workout"),
      ],
      "chill",
    );
    expect(screen.getByRole("button", { name: "Chill Vibes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Party Mix" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workout" })).toBeNull();
  });

  it("matches Vietnamese names diacritics-insensitively", () => {
    renderSubmenu(
      [makePlaylist("p1", "Đổi mới"), makePlaylist("p2", "Cà phê sữa")],
      "doi",
    );
    expect(screen.getByRole("button", { name: "Đổi mới" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cà phê sữa" })).toBeNull();
  });

  it("requires every query token to match (AND)", () => {
    renderSubmenu(
      [
        makePlaylist("p1", "Anh yêu em"),
        // "yeu thuong" contains "yeu" but not "anh" — the AND case must
        // still exclude it even though one token matches.
        makePlaylist("p2", "Yêu thương"),
      ],
      "anh yeu",
    );
    expect(screen.getByRole("button", { name: "Anh yêu em" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yêu thương" })).toBeNull();
  });

  it("shows every playlist when the query is empty", () => {
    renderSubmenu(
      [
        makePlaylist("p1", "Chill Vibes"),
        makePlaylist("p2", "Party Mix"),
        makePlaylist("p3", "Workout"),
      ],
      "",
    );
    expect(screen.getByRole("button", { name: "Chill Vibes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Party Mix" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workout" })).toBeTruthy();
  });
});
