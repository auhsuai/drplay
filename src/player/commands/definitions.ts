import type { PlayerCommand } from "./ids";
import { TRANSPORT_COMMANDS } from "./definitions/transport";
import { TRACK_COMMANDS } from "./definitions/tracks";
import { VOLUME_COMMANDS } from "./definitions/volume";
import { PLAYBACK_COMMANDS } from "./definitions/playback";
import { DELAY_COMMANDS } from "./definitions/delays";
import { VIDEO_COMMANDS } from "./definitions/video";
import { QUEUE_COMMANDS } from "./definitions/queue";
import { PIP_COMMANDS } from "./definitions/pip";

export { VOLUME_STEP } from "./definitions/volume";
export { VIDEO_ZOOM_STEP } from "./definitions/video";

export const COMMAND_DEFINITIONS: readonly PlayerCommand[] = [
  ...TRANSPORT_COMMANDS,
  ...TRACK_COMMANDS,
  ...VOLUME_COMMANDS,
  ...PLAYBACK_COMMANDS,
  ...DELAY_COMMANDS,
  ...VIDEO_COMMANDS,
  ...QUEUE_COMMANDS,
  ...PIP_COMMANDS,
];
