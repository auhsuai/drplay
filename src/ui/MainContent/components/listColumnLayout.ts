// Shared column grid for the My Drive list: header (FileListHeader) and rows
// (SongCard) MUST use these identical tokens so labels sit pixel-exactly above
// their values. Changing a track here moves both sides together.
export const LIST_ROW_PADDING = "p-3"; // card padding
export const LIST_HEADER_PADDING = "pl-3 pr-3"; // must equal LIST_ROW_PADDING horizontally
export const LIST_GAP = "gap-4";
export const LIST_ICON_TRACK = "w-12"; // icon tile / header spacer
// Date track absorbs the Size track's growth so the Date column's LEFT edge
// (aligned with the toolbar search box) and the total right-side budget stay
// unchanged: 204 + 64 = 268 = 184 + 84.
export const LIST_DATE_TRACK = "hidden sm:block w-[184px] shrink-0";
// 84px fits the widest realistic label ("1023.5 MB"); whitespace-nowrap stops
// long non-breaking values from wrapping onto a second line inside the card.
export const LIST_SIZE_TRACK = "w-[84px] shrink-0 text-right whitespace-nowrap";
export const LIST_ACTIONS_TRACK = "w-9"; // 36px MoreMenu trigger box
