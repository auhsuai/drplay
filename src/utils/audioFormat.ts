// Pure binary sniffing helpers for audio containers. No IO, no dependencies —
// every function is deterministic on its buffer input so the m4a faststart
// decision and AAC short-circuit stay unit-testable.

export { AUDIO_EXTENSION_TO_MIME, detectFormat } from "./audioFormat/detect";
export type { AudioFormat } from "./audioFormat/detect";
export {
  ID3V2_HEADER_LEN,
  findMpegDataStart,
  findMpegFrameSync,
  isMpegCbr,
  mpegCbrDurationFromSize,
  readId3v2TagSize,
} from "./audioFormat/mpeg";
export type { Mp4BoxWalk, MoovTailScan } from "./audioFormat/mp4";
export { scanTailForMoov, walkMp4TopBoxes } from "./audioFormat/mp4";
