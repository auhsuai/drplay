/** Everything EXCEPT positioning — shared by the root panel and every flyout. */
export const PANEL_BASE_CLASS =
  "z-[10000] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none";

/**
 * The root panel is placed by `getContextMenuStyle`'s inline left/top, so it is
 * viewport-positioned. The flyouts carry NO inline style and resolve
 * left-full/right-full against the `relative` row that wraps each parent — so
 * they must be `absolute`. The positioning utility therefore lives in a
 * SEPARATE constant on purpose: `fixed` and `absolute` have equal specificity,
 * so in one merged class whichever Tailwind emits later in the stylesheet wins
 * (measured: `.fixed` after `.absolute`), which silently turned every flyout
 * into a viewport-anchored panel and pushed it off-screen.
 */
export const ROOT_PANEL_CLASS = `fixed ${PANEL_BASE_CLASS}`;

export const SUBMENU_PANEL_CLASS = `absolute ${PANEL_BASE_CLASS}`;

export const SEPARATOR_CLASS =
  "my-1 h-px border-t border-gray-100 dark:border-gray-800/60";

/**
 * The queue can hold 50 rows. Boxing just that run keeps the flyout at roughly
 * five rows tall — the menu stays on screen instead of running off the top —
 * and every other track stays reachable by scrolling inside the box. Scrolling
 * it does NOT dismiss the menu: useMoreMenuEvents ignores a scroll whose target
 * is inside the panel.
 */
export const QUEUE_SCROLL_CLASS = "max-h-[10.5rem] overflow-y-auto";

/**
 * Hide the glyph INVISIBLY rather than removing the icon slot: the row keeps its
 * 16px column, so labels stay aligned with the rows next to them. Applied via
 * MoreMenuItem's existing `iconClassName` prop — the shared item renderer is not
 * touched.
 */
export const NO_GLYPH_ICON_CLASS = "w-4 h-4 opacity-0";

/**
 * The track being played, Playlist submenu only: DrPlay's brand blue instead of
 * the checkmark that used to sit in the (already blank) icon column.
 * `brand-text` is the project's theme-aware accent — #1967d2 on light, #8ab4f8
 * on dark, both AA on their surface (App.css owns the tokens).
 *
 * The `!` markers are deliberate, not laziness: the shared row class already
 * carries `hover:bg-gray-50 dark:hover:bg-[#33343a]` and `dark:text-gray-200`,
 * and two utilities of equal specificity are decided purely by which one
 * Tailwind emits last. Pinning the highlight makes "the playing track stays
 * blue, even under the pointer" a guarantee instead of a coin flip. Nothing
 * else on the row competes for background or text colour.
 */
export const QUEUE_CURRENT_CLASS =
  "text-brand-text! bg-brand-primary/10! dark:bg-brand-primary/15! hover:bg-brand-primary/20!";
