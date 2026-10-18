import { describe, expect, it } from "vitest";
import { episodeNumberFromName } from "./episodeNumber";

describe("episodeNumberFromName", () => {
  it("reads the standard S##E## form", () => {
    expect(episodeNumberFromName("Show.Name.S01E05.720p.mkv")).toBe("05");
    expect(episodeNumberFromName("Show.Name.s01e05.mkv")).toBe("05");
    expect(episodeNumberFromName("Show Name S2E3.mkv")).toBe("3");
    expect(episodeNumberFromName("Show.Name.S01.E05.mkv")).toBe("05");
    expect(episodeNumberFromName("Show.Name.S01_E05.mkv")).toBe("05");
  });

  it("reads the ##x## form", () => {
    expect(episodeNumberFromName("Show.Name.1x05.avi")).toBe("05");
    expect(episodeNumberFromName("Anime.Name.01x05.mkv")).toBe("05");
    expect(episodeNumberFromName("Anime.Name.1x001.mkv")).toBe("001");
  });

  it("reads the Episode / Ep / E keyword forms", () => {
    expect(episodeNumberFromName("Show.Name.Episode.12.mkv")).toBe("12");
    expect(episodeNumberFromName("Show.Name.Ep05.mkv")).toBe("05");
    expect(episodeNumberFromName("Show.Name.Ep.05.mkv")).toBe("05");
    expect(episodeNumberFromName("Show.Name.E05.mkv")).toBe("05");
    expect(
      episodeNumberFromName("[Group] Show Name - Episode 07 [720p].mkv"),
    ).toBe("07");
  });

  it("reads Japanese fansub numbering", () => {
    expect(episodeNumberFromName("[Group] Show - 第05話 [1080p].mkv")).toBe(
      "05",
    );
    expect(episodeNumberFromName("[Group] Show - 05話 [1080p].mkv")).toBe("05");
    expect(episodeNumberFromName("[Group] Show #05 [1080p].mkv")).toBe("05");
  });

  it("reads the anime absolute form, including a version tag", () => {
    expect(episodeNumberFromName("[Group] Anime Name - 05 [720p].mkv")).toBe(
      "05",
    );
    expect(episodeNumberFromName("[Group] Anime Name - 05v2 [720p].mkv")).toBe(
      "05",
    );
    expect(
      episodeNumberFromName("[Group] Anime Name - 038 [1080P][CF1029D9].mkv"),
    ).toBe("038");
    expect(
      episodeNumberFromName("[AEQG][1080p] Dragon Ball Z - 038 [1080P].mkv"),
    ).toBe("038");
    expect(episodeNumberFromName("Anime.Name.05.720p.WEB-DL.mkv")).toBe("05");
  });

  it("takes the first episode of a batch range", () => {
    expect(
      episodeNumberFromName(
        "[Group] Anime Name - 01-12 (BD 1080p) [C0FFEE].mkv",
      ),
    ).toBe("01");
  });

  it("never reads a resolution, a year, a CRC32 or a version as an episode", () => {
    expect(
      episodeNumberFromName("Movie.Name.2019.1080p.BluRay.mkv"),
    ).toBeNull();
    expect(episodeNumberFromName("[Group] Movie Name [1080p].mkv")).toBeNull();
    expect(episodeNumberFromName("Show.Name.1920x1080.mkv")).toBeNull();
    expect(episodeNumberFromName("[Group] Show [CF1029D9].mkv")).toBeNull();
    expect(
      episodeNumberFromName("Show.Name.720p.HDTV.x264-GROUP.mkv"),
    ).toBeNull();
    expect(episodeNumberFromName("Show Name 2019 1080p HEVC.mkv")).toBeNull();
  });

  it("keeps a zero-padded four-digit absolute number that only looks like a year", () => {
    expect(episodeNumberFromName("[Group] Show Name - 0189 [720p].mkv")).toBe(
      "0189",
    );
  });

  it("returns null when there is nothing that reads as an episode", () => {
    expect(episodeNumberFromName("Some Song.mp3")).toBeNull();
    expect(
      episodeNumberFromName("[Group] Movie Name - Director Cut [1080p].mkv"),
    ).toBeNull();
  });

  it("cannot tell an album from an episode on the name alone — the caller gates on video", () => {
    // Documented limitation, not a parser bug: "Album - 10 Tracks" and
    // "Show - 10 [720p]" are the same shape. menuModel only asks for a badge
    // on files classifyMediaKind reports as VIDEO.
    expect(episodeNumberFromName("Album - 10 Tracks.mp3")).toBe("10");
  });

  it("does not mistake a resolution written with a space for an episode", () => {
    expect(
      episodeNumberFromName("Show Name 1920 x 1080 BluRay.mkv"),
    ).toBeNull();
  });
});
