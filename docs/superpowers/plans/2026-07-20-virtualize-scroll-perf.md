# Virtual Scroll Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Replace paginated full-render with `@tanstack/react-virtual` v3 virtualization + image caching + `contain:strict` to eliminate CPU spike during scroll.

**Architecture:** Replace `currentItems.map()` with `useVirtualizer` from `@tanstack/react-virtual` v3. Only visible items (~12-15) are mounted as DOM nodes. Remove IntersectionObserver from SongCard (virtualizer handles visibility). Add module-level cover image cache (Map<string, string>) so remounted cards don't re-fetch cover URLs.

**Tech Stack:** @tanstack/react-virtual ^3.14.5 (already installed), React 19, TypeScript 5.8

## Global Constraints
- `noUnusedLocals: true`, `noUnusedParameters: true` in tsconfig — no dead code
- All existing tests must pass after changes
- `useFlushSync: false` for React 19 compatibility
- `directDomUpdates: true` for scroll performance (skip React re-renders)
- SongCard's custom `React.memo` comparator must be preserved

---

### Task 1: SongCard — Remove IntersectionObserver, Add Cover Image Cache

**Files:**
- Modify: `src/ui/MainContent/components/SongCard.tsx`
- Modify: `src/ui/MainContent/components/SongCard.test.tsx`

**Interfaces:**
- Consumes: SongCardProps (unchanged), metadataCache from `src/utils/metadata.ts`
- Produces: SongCard with `ref={virtualizer.measureElement}` via forwardRef, stable `data-index` on root div

**Changes in SongCard.tsx:**
1. Remove the `IntersectionObserver` useEffect block (lines 124-138) — virtualizer handles visibility, all mounted cards should fetch metadata immediately
2. Add module-level `const coverCache = new Map<string, string>()` — when `getTrackMetadata` returns a coverUrl, store it: `coverCache.set(item.id, coverUrl)`. On mount, check cache first: `if (coverCache.has(item.id)) setCoverUrl(coverCache.get(item.id)!);`
3. When `injectedCoverUrl` changes (windowing layer), also update cache
4. Add `forwardRef` so virtualizer can attach `measureElement` — the outer `.relative.group/card.w-full` div should accept a ref
5. Add `data-index` prop (optional, for virtualizer measurement)
6. The metadata fetch useEffect should now fire immediately when `shouldFetch` becomes true (which happens on mount since we removed IO). Change the guard from `shouldFetch` to just checking `item.isFolder && token`

**Changes in SongCard.test.tsx:**
1. Remove test that verifies IntersectionObserver triggers fetch — replace with "fetches metadata immediately on mount" test
2. Add test for cover image cache: mount SongCard with item.id='track-1', verify cache stores coverUrl, unmount + remount same id, verify no second fetch call
3. Update "does not self-fetch for folder items" test — still same behavior

---

### Task 2: MainContent — Replace Pagination with Virtualization

**Files:**
- Modify: `src/ui/MainContent/MainContent.tsx`
- Modify: `src/ui/MainContent/MainContent.windowing.test.tsx`

**Interfaces:**
- Consumes: MainContentProps (unchanged), SongCard (updated from Task 1)
- Produces: Virtualized MainContent with scroll-to-highlight, pagination controls unchanged

**Changes in MainContent.tsx:**
1. Import `useVirtualizer` from `@tanstack/react-virtual`
2. Add `contain: 'strict'` style to the `mainRef` element (the scroll container):
   ```tsx
   <main ref={mainRef} className="..." style={{ contain: 'strict' }}>
   ```
3. Replace the `currentItems.map()` block (lines 638-679) with virtualizer pattern:
   ```tsx
   const rowVirtualizer = useVirtualizer({
     count: currentItems.length,
     getScrollElement: () => mainRef.current,
     estimateSize: () => 92, // SongCard average height
     overscan: 5,
     getItemKey: (index) => currentItems[index].id,
     useFlushSync: false,
   });
   
   const virtualItems = rowVirtualizer.getVirtualItems();
   ```
4. The virtual items render:
   ```tsx
   <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
     {virtualItems.map((virtualRow) => {
       const item = currentItems[virtualRow.index];
       return (
         <div
           key={virtualRow.key}
           data-index={virtualRow.index}
           ref={rowVirtualizer.measureElement}
           style={{
             position: 'absolute',
             top: 0,
             left: 0,
             width: '100%',
             transform: `translateY(${virtualRow.start}px)`,
           }}
         >
           <SongCard
             item={item}
             onPlay={(track) => handlePlay(track)}
             onOpenFolder={onOpenFolder}
             token={token}
             currentFolderId={currentFolderId}
             currentFolderName={currentFolderName}
             folderHistory={folderHistory}
             isHighlighted={item.id === highlightedFileId?.id}
             highlightTrigger={item.id === highlightedFileId?.id ? highlightedFileId.ts : undefined}
             isPlaying={currentTrack?.id === item.id}
             onRefresh={onRefresh}
             onRemoveItem={onRemoveItem}
             isSelectionMode={isSelectionMode}
             isSelected={selectedIds.has(item.id)}
             onToggleSelection={() => { ... }}
             onEnableSelectionMode={() => { ... }}
             onBulkMoveClick={() => setShowBulkMoveScreen(true)}
             onBulkDeleteClick={() => setShowBulkDeleteConfirm(true)}
           />
         </div>
       );
     })}
   </div>
   ```
5. Update `scrollToIndex` for highlighted items — replace `querySelector('[data-hl-index]')` with `rowVirtualizer.scrollToIndex(index, { align: 'center' })`
6. Update page change handler — after `setCurrentPage`, call `mainRef.current?.scrollTo({ top: 0 })` (no smooth scroll to avoid visual glitch during virtualizer re-initialization)
7. Remove the `.pb-2` wrapper div pattern (no longer needed since virtualizer positions items absolutely)

**Changes in MainContent.windowing.test.tsx:**
1. Update the `@tanstack/react-virtual` mock to match new API:
   ```tsx
   vi.mock('@tanstack/react-virtual', () => ({
     useVirtualizer: vi.fn(() => ({
       getVirtualItems: () => Array.from({ length: 12 }, (_, i) => ({
         index: i, key: i, size: 92, start: i * 92, lane: 0,
       })),
       getTotalSize: () => 50 * 92,
       measureElement: vi.fn(),
       scrollToIndex: vi.fn(),
     })),
   }));
   ```
2. Adjust test expectations — with virtualization, 60 items page 1 renders ~12 virtual items, not 50. Test should check that SongCard is rendered and at least 1 card exists, not exact count.
3. Keep the "renders PAGE_SIZE items" test logic but check virtualizer.count === 50

---

### Task 3: Remove Global IntersectionObserver Polyfill

**Files:**
- Modify: `src/test-setup.ts`

**Changes:**
- Remove the IntersectionObserver polyfill block since SongCard no longer uses IO
- Keep `IS_REACT_ACT_ENVIRONMENT` line

---

### Task 4: Verify Build + Tests

**Steps:**
- [ ] Run `cd C:\Users\thinkpad\Desktop\Antigravity\drplay && npm test` — all tests pass
- [ ] Run `cd C:\Users\thinkpad\Desktop\Antigravity\drplay && npx tsc --noEmit` — no type errors
- [ ] Run `cd C:\Users\thinkpad\Desktop\Antigravity\drplay && npm run build` — build succeeds
