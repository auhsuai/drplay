import { emitTo } from "@tauri-apps/api/event";
import { armEvent, type EventWaiter } from "./events";
import {
  logPipFailure,
  PIP_ACK_TIMEOUT_MS,
  PIP_EVENTS,
  PIP_WINDOW_LABEL,
  type PipOwner,
} from "./shared";

interface OwnerPayload {
  owner?: PipOwner;
}

function ownerOf(payload: unknown): PipOwner | null {
  if (typeof payload !== "object" || payload === null) return null;
  const owner = (payload as OwnerPayload).owner;
  return owner === "main" || owner === "pip" ? owner : null;
}

export async function requestPipOwner(owner: PipOwner): Promise<boolean> {
  let waiter: EventWaiter;
  try {
    waiter = await armEvent(
      PIP_EVENTS.ownerAck,
      PIP_ACK_TIMEOUT_MS,
      (payload) => ownerOf(payload) === owner,
    );
  } catch (error) {
    logPipFailure("warn", "owner-ack-listen-failed", error);
    try {
      await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.owner, { owner });
    } catch (emitError) {
      logPipFailure("warn", "owner-emit-failed", emitError);
    }
    return false;
  }

  try {
    await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.owner, { owner });
    await waiter.promise;
    return true;
  } catch (error) {
    logPipFailure("warn", "owner-ack-failed", error);
    return false;
  } finally {
    waiter.dispose();
  }
}

export async function releasePipWindow(): Promise<boolean> {
  let waiter: EventWaiter;
  try {
    waiter = await armEvent(PIP_EVENTS.releaseAck, PIP_ACK_TIMEOUT_MS);
  } catch (error) {
    logPipFailure("warn", "release-ack-listen-failed", error);
    try {
      await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.release);
    } catch (emitError) {
      logPipFailure("warn", "release-emit-failed", emitError);
    }
    return false;
  }

  try {
    await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.release);
    await waiter.promise;
    return true;
  } catch (error) {
    logPipFailure("warn", "release-ack-failed", error);
    return false;
  } finally {
    waiter.dispose();
  }
}
