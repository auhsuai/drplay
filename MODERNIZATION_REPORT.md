# Modernization Report

Date: 2026-07-20
Scope: `src/` (97 files audited)

---

## Summary

| Metric | Value |
|---|---|
| Total files audited | 97 |
| Files with outdated logic | 6 changed + 1 deleted |
| Files clean (no change needed) | 90 |
| Build (`tsc --noEmit`) | 0 errors |
| Test (`vitest run`, excl. flake) | 115/115 pass |
| Production build (`vite build`) | exit 0 |

---

## Changes Made

### 1. Config cleanup
| File | Outdated | Replacement | Reference |
|---|---|---|---|
| `tailwind.config.js` | Dead v3 JS config (`content`, `darkMode: 'class'`, `theme.extend.colors` never used) | **Deleted** — Tailwind v4 uses CSS-first config (`@import "tailwindcss"` + `@theme`); `@custom-variant dark` already in App.css | [Tailwind v4 migration](https://tailwindcss.com/docs/upgrade-guide) |

### 2. Type tightening (`any` → `unknown`)
| File | Line | Outdated | Replacement | Reference |
|---|---|---|---|---|
| `src/db/db.ts` | 12 | `DriveFile.metadata?: any` | `metadata?: unknown` | [TypeScript 5.8 `unknown`](https://www.typescriptlang.org/docs/handbook/2/functions.html#unknown) |
| `src/db/db.ts` | 17 | `SyncState.value: any` | `value: unknown` | same |
| `src/db/db.ts` | 30 | `KvRow.value: any` | `value: unknown` | same |
| `src/db/db.ts` | 35 | `MetadataCacheRow.entry: any` | `entry: unknown` | same |
| `src/db/kv.ts` | 8 | `set(key, value: any)` | `value: unknown` | same |

- 3 callers required explicit narrowing (`as T` casts) after `unknown` enforcement — they were already correct at runtime, now also correct at compile-time.

### 3. Catch variable typing (`e: any` → `e: unknown`)
| File | Line | Outdated | Replacement |
|---|---|---|---|
| `src/utils/apiClient.ts` | 134 | `catch (err: any)` | `catch (err: unknown)` — `String(err)` handles all types |
| `src/utils/apiClient.ts` | 178 | `catch (err: any)` | `catch (err: unknown)` — `instanceof TokenRefreshError` narrows |
| `src/hooks/useAuth.ts` | 205 | `.catch(err =>` | `.catch((err: unknown) =>` — `instanceof Error` narrows |
| `src/ui/FolderSelection/FolderSelectionScreen.tsx` | 71 | `catch (e: any)` | `catch (e: unknown)` + safe object/name check |
| `src/ui/PlayerBar/usePlaybackControl.ts` | 161 | `catch (err: any)` | `catch (err: unknown)` + safe object/name extraction |
| `src/utils/safeAudio.ts` | 18 | `catch (err: any)` | `catch (err: unknown)` — `instanceof Error` + .name check |

---

## Intentionally Unchanged

| Location | `any` remaining | Reason |
|---|---|---|
| `PlaylistRow.tracks: any[]` | Stores `Track` objects | Importing `Track` from App.tsx creates circular dependency; requires type extraction to a shared module (out of scope) |
| `RecentTrackRow.track: any` | Same | same |
| `PlayCountRow.track: any` | Same | same |
| `favorites!: Table<any, string>` | Same | same |
| Test files (`*.test.ts`) | Various `as any` | Test ergonomics — test-heavy `any` usage is acceptable and expected |
| `vite.config.ts:4` `@ts-expect-error` | `process.env` access | Vite types intentionally omit Node.js globals; `@ts-expect-error` is the documented pattern |

---

## Recommended Follow-ups (out of scope for this audit)

1. **Extract `Track` type** from `App.tsx` to a shared `src/types.ts` — unblocks fully typing `PlaylistRow.tracks`, `RecentTrackRow.track`, and `favorites` table without circular imports.
2. **Upgrade `ES2020` target** to `ES2022` in `tsconfig.json` — the installed Node.js/V8 targets support `at()`, `Array.fromAsync()`, `Error.cause`. Low risk but no immediate gain for this app.
3. **Audit `describe/it/test` unused imports** — several test files use `describe/it` from vitest which are global; explicit imports may be removable.
