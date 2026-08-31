import { describe, expect, it } from "vitest";
import {
  BACKGROUND_PLAYBACK_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  DB_NAV_STATE_KEY as STORAGE_DB_NAV_STATE_KEY,
  FOLDER_HISTORY_KEY,
  ROOT_FOLDER_KEY,
  SORT_OPTION_KEY,
} from "./utils/storageKeys";
import {
  DB_NAV_STATE_KEY as APP_UI_DB_NAV_STATE_KEY,
  LS_BACKGROUND_PLAYBACK,
  LS_CURRENT_FOLDER_ID,
  LS_CURRENT_FOLDER_NAME,
  LS_FOLDER_HISTORY,
  LS_ROOT_FOLDER,
  LS_SORT_OPTION,
} from "./appUiState";

// Dedup lock (Phase C-lite, zero behavior change): every appUiState key must
// resolve to the SAME binding defined in utils/storageKeys.ts — the single
// source of truth for localStorage keys. If someone reintroduces a duplicated
// literal in appUiState and the two sources drift apart, these assertions
// fail loudly before any consumer reads a stale key.
describe("appUiState storage-key dedup lock", () => {
  it("resolves every exported key to its storageKeys source constant", () => {
    expect(LS_ROOT_FOLDER).toBe(ROOT_FOLDER_KEY);
    expect(LS_CURRENT_FOLDER_ID).toBe(CURRENT_FOLDER_ID_KEY);
    expect(LS_CURRENT_FOLDER_NAME).toBe(CURRENT_FOLDER_NAME_KEY);
    expect(LS_FOLDER_HISTORY).toBe(FOLDER_HISTORY_KEY);
    expect(LS_SORT_OPTION).toBe(SORT_OPTION_KEY);
    expect(LS_BACKGROUND_PLAYBACK).toBe(BACKGROUND_PLAYBACK_KEY);
    expect(APP_UI_DB_NAV_STATE_KEY).toBe(STORAGE_DB_NAV_STATE_KEY);
  });
});
