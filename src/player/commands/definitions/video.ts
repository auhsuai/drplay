import i18next from "i18next";
import {
  addVideoZoom,
  aspectCycleValue,
  clearAbLoop,
  deinterlaceCycle,
  getAbLoop,
  getAspectOverride,
  getDeinterlace,
  resetVideoView,
  setAbLoopA,
  setAbLoopB,
  setAspectOverride,
  setDeinterlace,
  takeScreenshot,
} from "../../../lib/mpvControl";
import { emitPlayerUi } from "../../playerUiBus";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { commandModifier, noModifiers } from "./helpers";

/** mpv `video-zoom` nudge per keypress. */
export const VIDEO_ZOOM_STEP = 0.1;

export const VIDEO_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ASPECT_CYCLE,
    labelKey: "player.command.aspect_cycle",
    shortcut: "R",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "r",
    run: async () => {
      await setAspectOverride(aspectCycleValue(await getAspectOverride()));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_DEINTERLACE_CYCLE,
    labelKey: "player.command.deinterlace_cycle",
    shortcut: "D",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "d",
    run: async () => {
      await setDeinterlace(deinterlaceCycle(await getDeinterlace()));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW,
    labelKey: "player.command.fit_window",
    shortcut: "Ctrl+0",
    preventDefault: true,
    match: (e) => commandModifier(e) && e.key === "0",
    run: async () => {
      await resetVideoView();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN,
    labelKey: "player.command.zoom_in",
    shortcut: "Ctrl+=",
    preventDefault: true,
    repeatable: true,
    // Both Ctrl+= and Ctrl+Shift+= (which reports "+") zoom in: the shifted
    // chord is what a US layout produces when Shift is held by muscle memory.
    match: (e) => commandModifier(e) && (e.key === "=" || e.key === "+"),
    run: async () => {
      await addVideoZoom(VIDEO_ZOOM_STEP);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ZOOM_OUT,
    labelKey: "player.command.zoom_out",
    shortcut: "Ctrl+-",
    preventDefault: true,
    repeatable: true,
    match: (e) => commandModifier(e) && e.key === "-",
    run: async () => {
      await addVideoZoom(-VIDEO_ZOOM_STEP);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT,
    labelKey: "player.command.snapshot",
    shortcut: "Ctrl+S",
    preventDefault: true,
    // Shift is reserved for PLAYER_SHUFFLE (Ctrl+Shift+S) — keep the matchers
    // disjoint so Ctrl+Shift+S can never take a screenshot.
    match: (e) =>
      commandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "s",
    run: async () => {
      await takeScreenshot();
      emitPlayerUi("toast", {
        variant: "success",
        message: i18next.t("player.command.snapshot_saved"),
      });
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO,
    labelKey: "player.command.media_info",
    shortcut: "I",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "i",
    run: () => {
      // D2b subscribes and opens the Media Info dialog.
      emitPlayerUi("media-info");
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AB_LOOP,
    labelKey: "player.command.ab_loop",
    shortcut: "L",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "l",
    run: async (ctx) => {
      // Three-state cycle: set A -> set B -> clear. The current media time is
      // the engine's clock, so each press pins the point the user is hearing.
      const loop = await getAbLoop();
      if (loop.a === null) {
        await setAbLoopA(ctx.audio.getCurrentTime());
        emitPlayerUi("toast", {
          variant: "success",
          message: i18next.t("player.command.ab_loop_a_set"),
        });
        return;
      }
      if (loop.b === null) {
        await setAbLoopB(ctx.audio.getCurrentTime());
        emitPlayerUi("toast", {
          variant: "success",
          message: i18next.t("player.command.ab_loop_b_set"),
        });
        return;
      }
      await clearAbLoop();
      emitPlayerUi("toast", {
        variant: "success",
        message: i18next.t("player.command.ab_loop_cleared"),
      });
    },
  },
];
