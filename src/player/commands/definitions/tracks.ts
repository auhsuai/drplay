import {
  getTrackList,
  nextTrackId,
  setAudioTrack,
  setSubtitleTrack,
  toggleSubtitleVisibility,
} from "../../../lib/mpvControl";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { noModifiers } from "./helpers";

async function selectAdjacentTrack(
  type: "audio" | "sub",
  direction: 1 | -1,
  apply: (id: number) => Promise<void>,
): Promise<void> {
  const tracks = (await getTrackList()).filter((track) => track.type === type);
  const currentId = tracks.find((track) => track.selected)?.id ?? null;
  const nextId = nextTrackId(tracks, currentId, direction);
  if (nextId === null) return;
  await apply(nextId);
}

export const TRACK_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_NEXT,
    labelKey: "player.command.audio_next",
    shortcut: "A",
    preventDefault: false,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "a",
    run: async () => {
      await selectAdjacentTrack("audio", 1, setAudioTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_PREV,
    labelKey: "player.command.audio_prev",
    shortcut: "Shift+A",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "a",
    run: async () => {
      await selectAdjacentTrack("audio", -1, setAudioTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_NEXT,
    labelKey: "player.command.subtitle_next",
    shortcut: "V",
    preventDefault: false,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "v",
    run: async () => {
      await selectAdjacentTrack("sub", 1, setSubtitleTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_VISIBLE,
    labelKey: "player.command.subtitle_visible",
    shortcut: "Shift+V",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "v",
    run: async () => {
      await toggleSubtitleVisibility();
    },
  },
];
