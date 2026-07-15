# PlayerBar Split Design

**Date:** 2026-07-13
**HEAD:** 4cc360b
**Goal:** Split 1529-line `PlayerBar.tsx` into focused modules with explicit dependency injection.

## Architecture

```
types.ts → playerReducer.ts → usePlayerState.ts
                                         ↓
useTrackMetadata.ts → useAudioEngine.ts → useAudioEngine (returned API)
useKeyboard.ts        usePlaybackControl.ts → uses AudioEngine + PlayerState
useProgressUI.ts      useErrorDisplay.ts
                       +→ PlayerBar.tsx (compose hooks + JSX)
```

## File Catalog

| File | Responsibility | Testable |
|---|---|---|
| `types.ts` | Shared interfaces: `AudioRefs`, `PositionRefs`, `CallbackRefs`, `PlaybackRefs`, `PlayerAction`, `PlayerState`, `PlayerBarProps` | — |
| `playerReducer.ts` | Pure function `playerReducer`, `initialPlayerState`, `PlayerAction`, `PlayerState` | Pure, 0 deps |
| `usePlayerState.ts` | `useReducer` wrapper + `isPlayingRef`/`errorInfoRef` syncing + `TRACK_CHANGE` dispatch on track change | Low |
| `useAudioEngine.ts` | `audioRef`/`audioRef2`/`crossfadeEngineRef`, `getActiveAudio()`, `loadNormalAudio()`, `performRetry()`, `cleanupResumeHandlers()`, crossfade `loadNonce` effect, all `<audio>` event handlers (ended, error, timeupdate, loadedmetadata, canplay), volume sync, seek correction effect | Medium (mock audio elements) |
| `usePlaybackControl.ts` | `handleNextClick`/`handlePrevClick`, circuit breaker, `handleManualResume`, `handleRetry`, `handleOnline`/`handleOffline`, Tauri listeners (token-expired, drive-quota, buffer-status), `isPlaying` effect bridge, rate limit guard, `player-stop` event, bluetooth devicechange | Medium |
| `useKeyboard.ts` | `keydown`/`keyup` listeners, arrow seeking logic, volume/navigation shortcuts | Medium (mock DOM events) |
| `useTrackMetadata.ts` | Metadata fetch (title/artist/cover), favorites sync, `buffer-status` Tauri listener, session save (`beforeunload` + periodic), `handleLoadedMetadata` duration update | Medium |
| `useErrorDisplay.ts` | Error classification (banner vs toast), toast lifecycle (timer, visibility, dismiss), `ErrorIcon` component, `<audio>` focus sync effect, `player-stop` mediaSession reset | High (pure classification, timer-based) |
| `useProgressUI.ts` | Progress bar `handlePointerDown`/drag, `updateProgressUI` effect, arrow seeking visual update | Low |
| `PlayerBar.tsx` | Compose all hooks, render ~200 lines JSX | — |

## Dependency Injection

Every hook receives an `AudioRefs`, `PositionRefs`, `CallbackRefs`, or `PlaybackRefs` object — no global ref sharing:

```typescript
// Example: useAudioEngine signature
function useAudioEngine(
  audioRefs: AudioRefs,
  playerState: PlayerStateCtx,
  callbackRefs: CallbackRefs,
  t: TFunction,
): AudioEngineAPI
```

```typescript
// Example: usePlaybackControl signature  
function usePlaybackControl(
  audioEngine: AudioEngineAPI,
  playerState: PlayerStateCtx,
  playbackRefs: PlaybackRefs,
  callbackRefs: CallbackRefs,
  props: { currentTrack, isPlaying, playMode, crossfadeEnabled, crossfadeDuration, loadNonce, onTogglePlay, onNextTrack, onPrevTrack },
  errorDisplay: { errorInfo },
): PlaybackControlAPI
```

## Migration Strategy

1. **Phase 0:** Create `types.ts`, `playerReducer.ts`, `usePlayerState.ts` — extract without touching PlayerBar.tsx
2. **Phase 1:** Create `useAudioEngine.ts` — move audio engine logic + crossfade + event handlers
3. **Phase 2:** Create `useKeyboard.ts` — move keyboard logic
4. **Phase 3:** Create `useTrackMetadata.ts` — move metadata + favorites + session
5. **Phase 4:** Create `useErrorDisplay.ts` — move error UI + toast + audio focus
6. **Phase 5:** Create `usePlaybackControl.ts` — move navigation + Tauri listeners + recovery
7. **Phase 6:** Create `useProgressUI.ts` — move progress bar interaction
8. **Phase 7:** Rewrite `PlayerBar.tsx` — compose hooks + render

Each phase: extract & import — file must compile at every step.
