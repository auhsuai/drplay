# Stream Security Fixes — Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` (recommended) or `executing-plans` to implement. Steps use `- [ ]` checkbox syntax.

**Goal:** Fix 3 remaining security vulnerabilities: unsigned `ext` parameter, unvalidated download path, and Drive API query injection.

**Architecture:** 3 independent tasks — 1 Rust (HMAC include `ext`), 2 TypeScript (download path validation + query escaping). Each can be done in any order.

**Tech Stack:** Rust + HMAC-SHA256 (already in lib.rs), Tauri PathResolver + SafePathBuf + fs scope, Google Drive API query grammar.

---

### Task 1: Include `ext` in HMAC signature

**Files:**
- Modify: `src-tauri/src/lib.rs:192-196`

**Approach:** Current HMAC is computed over `file_id:exp` only — `ext` appended after signing, so it can be injected without detection. Fix: include `ext` in the HMAC payload.

- [ ] **Step 1: Update HMAC payload to include `ext`**

Current (`line 192`):
```rust
let payload = format!("{}:{}", file_id, exp);
```

Change to:
```rust
let payload = format!("{}:{}:{}", file_id, ext_str, exp);
```

Also update `proxy.rs` verification to match.

- [ ] **Step 2: Update proxy verification**

Find the HMAC verification in `proxy.rs` — `line 164-184` area — and change the payload to match:
```rust
// current
let payload = format!("{}:{}", query.id, exp);

// new
let payload = format!("{}:{}:{}", query.id, ext.unwrap_or_default(), exp);
```

- [ ] **Step 3: Build & verify**

Run: `cargo check` in `src-tauri/`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/proxy.rs
git commit -m "fix: include ext param in HMAC signature to prevent URL injection"
```

---

### Task 2: Validate download path from localStorage

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/utils/downloadPath.ts`
- Modify: `src/ui/components/GlobalContextMenu.tsx:96-100`

**Approach:** Tauri v2 `plugin:fs` already blocks `../` via `SafePathBuf`. But download dir could point to `C:\Windows`. Fix: add fs scope in capabilities, validate path against safe directories.

- [ ] **Step 1: Add fs scope to capabilities**

In `src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "http:default",
    {
      "identifier": "http:default",
      "allow": [{ "url": "https://*.googleapis.com/*" }, { "url": "https://*.googleusercontent.com/*" }]
    },
    "fs:default",
    {
      "identifier": "fs:scope",
      "allow": [
        { "path": "$DOWNLOAD/**" },
        { "path": "$DESKTOP/**" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Add `isSafeDownloadPath` to `downloadPath.ts`**

```typescript
import { downloadDir, desktopDir } from "@tauri-apps/api/path";

const SAFE_PREFIXES_KEY = "__drplay_safe_dirs";

async function getSafePrefixes(): Promise<string[]> {
  const cached = sessionStorage.getItem(SAFE_PREFIXES_KEY);
  if (cached) return JSON.parse(cached);
  const prefixes = await Promise.all([
    downloadDir(),
    desktopDir(),
  ]);
  sessionStorage.setItem(SAFE_PREFIXES_KEY, JSON.stringify(prefixes));
  return prefixes;
}

export async function isSafeDownloadPath(path: string): Promise<boolean> {
  try {
    if (path.includes('..') || path.includes('./')) return false;
    const prefixes = await getSafePrefixes();
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return prefixes.some(p => normalized.startsWith(p.replace(/\\/g, '/').toLowerCase()));
  } catch { return false; }
}
```

- [ ] **Step 3: Guard download in `GlobalContextMenu.tsx`**

After getting `downloadDirPath`, before writing:
```typescript
const downloadDirPath = await getEffectiveDownloadPath();

if (!(await isSafeDownloadPath(downloadDirPath))) {
  console.error("Unsafe download path:", downloadDirPath);
  setDownloadingState('error');
  setTimeout(() => setDownloadingState('idle'), 3000);
  return;
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` then `npx vitest run`
Expected: no errors, tests pass

- [ ] **Step 5: Commit**

```bash
git add src-tauri/capabilities/default.json src/utils/downloadPath.ts src/ui/components/GlobalContextMenu.tsx
git commit -m "fix: validate download path against safe directories and add fs scope"
```

---

### Task 3: Fix Drive API query injection in FolderSelectionScreen

**Files:**
- Modify: `src/ui/FolderSelection/FolderSelectionScreen.tsx:55`

**Problem:** `query.replace(/'/g, "\\'")` escapes `'` but not `\` — backslash before closing quote escapes it, breaking out of the string.

- [ ] **Step 1: Fix escaping**

```typescript
const safeQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const q = `name contains '${safeQuery}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/ui/FolderSelection/FolderSelectionScreen.tsx
git commit -m "fix: escape backslash before single quote in Drive API query"
```
