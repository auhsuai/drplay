/**
 * Video context-menu model (D2b). PURE data: one snapshot read when the menu
 * opens (spec §22), one builder per section, one dispatcher for the returned
 * item id. The registry (commands.ts) stays the single source of truth for
 * command labels/shortcuts/behavior — menu-only entries use `menu:*` ids and
 * are dispatched here.
 *
 * The implementation lives in `menuModel/`; this file only re-exports the
 * public surface so every existing import path keeps working.
 */

export {
  DEFAULT_QUEUE_MENU_LIMIT,
  MENU_IDS,
  MENU_LABEL_MAX_LENGTH,
  MENU_PREFIXES,
} from "./menuModel/constants";
export { formatTrackLabel, truncateLabel } from "./menuModel/labels";
export {
  takeVideoMenuSnapshot,
  type VideoMenuSnapshot,
} from "./menuModel/snapshot";
export {
  buildContextMenuModel,
  queueMenuSlice,
  type MenuSection,
} from "./menuModel/builders";
export { runMenuEntry } from "./menuModel/dispatch";
