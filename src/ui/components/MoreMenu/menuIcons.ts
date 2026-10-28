import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Captions,
  Circle,
  Crop,
  Eye,
  FilePlus,
  Film,
  Flag,
  Gauge,
  Info,
  ListMusic,
  ListVideo,
  Maximize,
  MonitorPlay,
  PictureInPicture2,
  Play,
  Ratio,
  Repeat,
  Scan,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  Speaker,
  Square,
  Subtitles,
  Timer,
  Volume2,
  VolumeX,
  ZoomIn,
} from "lucide-react";
import type { NativeMenuEntry, NativeMenuItem } from "../../../lib/nativeMenu";
import { MENU_IDS, MENU_PREFIXES } from "../../../player/menuModel";

/** A queue row — the run that gets boxed into the scroll area, and the only
 *  place the check column is replaced by the brand highlight. */
export function isQueueItem(entry: NativeMenuEntry): entry is NativeMenuItem {
  return entry.kind === "item" && entry.id.startsWith(MENU_PREFIXES.queue);
}

/** Exact ids: menu sections, their children, and the PLAYER_* commands. */
const ICONS_BY_ID: Readonly<Record<string, LucideIcon>> = {
  [MENU_IDS.fullAudio]: Volume2,
  [MENU_IDS.fullVideo]: MonitorPlay,
  [MENU_IDS.fullSubtitle]: Captions,
  [MENU_IDS.fullPlayback]: Gauge,
  [MENU_IDS.fullPlaylist]: ListMusic,
  [MENU_IDS.audioTrack]: AudioLines,
  [MENU_IDS.audioDevice]: Speaker,
  [MENU_IDS.audioDelay]: Timer,
  [MENU_IDS.videoTrack]: Film,
  [MENU_IDS.aspect]: Ratio,
  [MENU_IDS.zoom]: ZoomIn,
  [MENU_IDS.crop]: Crop,
  [MENU_IDS.deinterlace]: Sparkles,
  [MENU_IDS.subtitleTrack]: Subtitles,
  [MENU_IDS.secondarySubtitle]: Subtitles,
  [MENU_IDS.addSubtitle]: FilePlus,
  [MENU_IDS.subDelay]: Timer,
  [MENU_IDS.speed]: Gauge,
  [MENU_IDS.chapters]: ListVideo,
  [MENU_IDS.setA]: Flag,
  [MENU_IDS.setB]: Flag,
  [MENU_IDS.clearAb]: Flag,
  [MENU_IDS.repeat]: Repeat,
  // The context menu's PiP row is `menu:pip`, NOT the PLAYER_PIP_TOGGLE
  // command id: `builders.ts` emits a menu-owned item and `dispatch.ts` routes
  // it to `ctx.enterPip`. Without this entry the row falls through to the
  // default glyph, which is why it used to render as an empty circle.
  [MENU_IDS.pip]: PictureInPicture2,
  PLAYER_PLAY_PAUSE: Play,
  PLAYER_STOP: Square,
  PLAYER_NEXT: SkipForward,
  PLAYER_PREVIOUS: SkipBack,
  PLAYER_FULLSCREEN: Maximize,
  PLAYER_PIP_TOGGLE: PictureInPicture2,
  PLAYER_MUTE: VolumeX,
  PLAYER_VOLUME_UP: Volume2,
  PLAYER_VOLUME_DOWN: Volume2,
  PLAYER_SUBTITLE_VISIBLE: Eye,
  PLAYER_FIT_WINDOW: Scan,
  PLAYER_MEDIA_INFO: Info,
  PLAYER_QUEUE_TOGGLE: ListMusic,
  PLAYER_SHUFFLE: Shuffle,
};

/**
 * Prefixes for the generated leaves (track / chapter / device / queue ids). No
 * two prefixes can both match one id, so the first hit is the only hit.
 */
const ICONS_BY_PREFIX: ReadonlyArray<readonly [string, LucideIcon]> = [
  [MENU_PREFIXES.audio, AudioLines],
  [MENU_PREFIXES.device, Speaker],
  [MENU_PREFIXES.video, Film],
  [MENU_PREFIXES.sub, Subtitles],
  [MENU_PREFIXES.secondary, Subtitles],
  [MENU_PREFIXES.chapter, ListVideo],
  [MENU_PREFIXES.speed, Gauge],
  [MENU_PREFIXES.aspect, Ratio],
  [MENU_PREFIXES.zoom, ZoomIn],
  [MENU_PREFIXES.crop, Crop],
  [MENU_PREFIXES.deinterlace, Sparkles],
  [MENU_PREFIXES.subDelay, Timer],
  [MENU_PREFIXES.audioDelay, Timer],
  [MENU_PREFIXES.repeat, Repeat],
  [MENU_PREFIXES.queue, ListMusic],
];

const DEFAULT_ICON: LucideIcon = Circle;

/**
 * True only on a pointer-driven device, so a tap/touch (or any hoverless input
 * method) keeps click-to-toggle instead of opening a flyout under a finger.
 * jsdom implements no `matchMedia` (verified on jsdom 29) — same fallback the
 * other responsive helpers here use.
 */
export function hasHoverPointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export function iconForEntry(id: string): LucideIcon {
  const exact = ICONS_BY_ID[id];
  if (exact) return exact;
  for (const [prefix, Icon] of ICONS_BY_PREFIX) {
    if (id.startsWith(prefix)) return Icon;
  }
  return DEFAULT_ICON;
}
