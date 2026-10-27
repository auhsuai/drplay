/** Label budget: native menus clip long strings, so long titles are cut. */
export const MENU_LABEL_MAX_LENGTH = 60;

/** Queue slice window (spec §playlist). */
export const DEFAULT_QUEUE_MENU_LIMIT = 50;

/** Parent/leaf ids the builder emits; also the dispatcher's vocabulary. */
export const MENU_IDS = {
  fullAudio: "menu:audio",
  fullVideo: "menu:video",
  fullSubtitle: "menu:subtitle",
  fullPlayback: "menu:playback",
  fullPlaylist: "menu:playlist",
  audioTrack: "menu:audio-track",
  audioDevice: "menu:audio-device",
  audioDelay: "menu:audio-delay",
  videoTrack: "menu:video-track",
  aspect: "menu:aspect",
  zoom: "menu:zoom",
  crop: "menu:crop",
  deinterlace: "menu:deinterlace",
  subtitleTrack: "menu:subtitle-track",
  secondarySubtitle: "menu:secondary-subtitle",
  addSubtitle: "menu:add-subtitle",
  subDelay: "menu:sub-delay",
  speed: "menu:speed",
  chapters: "menu:chapters",
  setA: "menu:ab:a",
  setB: "menu:ab:b",
  clearAb: "menu:ab:clear",
  repeat: "menu:repeat",
  pip: "menu:pip",
} as const;

export const MENU_PREFIXES = {
  audio: "menu:audio:",
  device: "menu:device:",
  video: "menu:video:",
  sub: "menu:sub:",
  secondary: "menu:secondary:",
  chapter: "menu:chapter:",
  speed: "menu:speed:",
  aspect: "menu:aspect:",
  zoom: "menu:zoom:",
  crop: "menu:crop:",
  deinterlace: "menu:deinterlace:",
  subDelay: "menu:sub-delay:",
  audioDelay: "menu:audio-delay:",
  repeat: "menu:repeat:",
  queue: "menu:queue:",
} as const;

/** mpv track-selection sentinel ("no" disables the track). */
export const TRACK_NONE = "no";

export const DEINTERLACE_MENU_PRESETS = [
  { value: "no", labelKey: "player.menu.deinterlace_off" },
  { value: "auto", labelKey: "player.menu.deinterlace_auto" },
  { value: "yes", labelKey: "player.menu.deinterlace_on" },
] as const;

export const REPEAT_MENU_PRESETS = [
  { mode: "normal", labelKey: "player.menu.repeat_off" },
  { mode: "repeat-one", labelKey: "player.menu.repeat_track" },
  { mode: "repeat-all", labelKey: "player.menu.repeat_queue" },
] as const;
