import MiniSearch from "minisearch";
import { normalizeText } from "../utils/normalizeText";
import { compareNatural } from "../utils/naturalSortCollator";
import { METADATA_KEY_PREFIX } from "../utils/metadata/constants";
import type { CachedMetadata } from "../utils/metadata/types";
import {
  isRealCacheEntry,
  stripExtension,
} from "../utils/metadata/pipelineHelpers";
import type { DriveFile, MetadataCacheRow } from "../db/db";

// Pure functions over MiniSearch (v7), Vietnamese-aware via the shared
// normalizeText util. Hosted in search.worker.ts via useSearchWorker.

export interface SearchDoc {
  id: string;
  name: string;
  isFolder: boolean;
  title?: string;
  artist?: string;
  parentId: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
}

export interface SearchHit {
  id: string;
  score: number;
  name: string;
  isFolder: boolean;
  title: string;
  artist: string | null;
  parentId: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
}

// Sentinel id of the synthetic "Root Folders" node (driveConstants). Repeated
// here as a literal because the worker/engine must stay import-light (the
// real constant imports nothing heavy, but the engine is hosted in a Worker
// realm where driveConstants pulls the whole shared-constants module).
const VIRTUAL_ROOT_ID = "__drplay_virtual_root__";

// Query context: which roots the search is scoped to and (in recursive mode)
// which folder's subtree is being browsed. Optional precomputed artifacts let
// the worker cache the O(n) BFS across keystrokes (B1.3) — the engine only
// computes them when absent (inline executor / tests).
export interface SearchQueryScope {
  mode: "global" | "recursive";
  rootIds: string[];
  currentFolderId?: string;
  /** Precomputed parent->children adjacency (cached by the worker). */
  parentToChildren?: Map<string, Set<string>>;
  /** Precomputed root membership set (cached by the worker). */
  inRootIds?: Set<string>;
}

// Sort spec for query results; default (undefined) = relevance (score desc).
export interface SearchSortSpec {
  field: "relevance" | "name" | "modifiedTime" | "size";
  dir: "asc" | "desc";
}

// The no-spec default. Equal to what the hook sends, so the engine's default
// ordering and an explicit relevance request can never disagree.
const DEFAULT_RELEVANCE: SearchSortSpec = { field: "relevance", dir: "desc" };

// Name matches matter most, then real ID3 title, then artist (plan: exact >
// prefix > fuzzy; name > title > artist).
const NAME_BOOST = 3;
const TITLE_BOOST = 2;
const ARTIST_BOOST = 1.5;
// Fractional fuzziness: max edit distance = 20% of the term length.
const FUZZY = 0.2;

// Strips the metadata_ key prefix (metadata.ts:6) so the map keys are fileIds
// matching DriveFile.id. Keys without the prefix are used verbatim.
function fileIdFromKey(key: string): string {
  return key.startsWith(METADATA_KEY_PREFIX)
    ? key.slice(METADATA_KEY_PREFIX.length)
    : key;
}

// Whitespace-split + normalization: one token per non-empty term, normalized
// to the same term space used at index time (processTerm).
function tokenizeQuery(query: string): string[] {
  return query.split(/\s+/).filter(Boolean).map(normalizeText);
}

export function loadRealMetadata(
  rows: MetadataCacheRow[],
): Map<string, CachedMetadata> {
  const result = new Map<string, CachedMetadata>();
  for (const row of rows) {
    if (!isRealCacheEntry(row.entry)) continue;
    result.set(fileIdFromKey(row.key), row.entry.data);
  }
  return result;
}

export function buildSearchIndex(
  files: DriveFile[],
  realMetadata: ReadonlyMap<string, CachedMetadata>,
): MiniSearch<SearchDoc> {
  const index = new MiniSearch<SearchDoc>({
    idField: "id",
    fields: ["name", "title", "artist"],
    // title/artist are indexed AND stored: queryIndex must return the real
    // metadata title/artist on SearchHit (interface contract) and MiniSearch
    // exposes stored fields only through storeFields.
    storeFields: [
      "name",
      "isFolder",
      "parentId",
      "mimeType",
      "size",
      "modifiedTime",
      "title",
      "artist",
    ],
    // v7 API: constructor-level `boost` no longer exists (v6 signature); it
    // lives in SearchOptions — set via `searchOptions` so the name > title >
    // artist priority applies to every search (merged under per-call options).
    searchOptions: {
      boost: { name: NAME_BOOST, title: TITLE_BOOST, artist: ARTIST_BOOST },
    },
    // Vietnamese normalization at both index and query time keeps them on the
    // same term space. null drops terms that normalized to nothing (e.g. a
    // lone combining mark) — MiniSearch skips falsy processTerm results.
    processTerm: (term) => normalizeText(term) || null,
  });

  const docs: SearchDoc[] = files.map((f) => {
    const doc: SearchDoc = {
      id: f.id,
      name: f.name,
      isFolder: f.isFolder,
      parentId: f.parentId,
      mimeType: f.mimeType,
    };
    // exactOptionalPropertyTypes: only write optional fields when defined.
    if (f.size !== undefined) doc.size = f.size;
    if (f.modifiedTime !== undefined) doc.modifiedTime = f.modifiedTime;
    // title/artist come ONLY from real metadata and only for files — folders
    // are never decorated, even if a stray metadata row exists for them.
    if (!f.isFolder) {
      const meta = realMetadata.get(f.id);
      if (meta) {
        doc.title = meta.title;
        doc.artist = meta.artist;
      }
    }
    return doc;
  });

  index.addAll(docs);
  return index;
}

// ---- Root scoping (B1/B2) -------------------------------------------------
// Membership and subtree resolution run over the INDEXED docs (not the DB),
// so both the real worker and the inline executor share one implementation.

// Adjacency parent -> children, deduped via Set, self-parent edges dropped
// (direct cycles can never contribute a distinct child anyway).
export function buildParentToChildren(
  index: MiniSearch<SearchDoc>,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const doc of index.documentCount ? searchAllDocs(index) : []) {
    if (doc.parentId === doc.id) continue;
    const children = adjacency.get(doc.parentId);
    if (children) children.add(doc.id);
    else adjacency.set(doc.parentId, new Set([doc.id]));
  }
  return adjacency;
}

// MiniSearch exposes no public "all documents" API; wildcard search returns
// every doc with stored fields intact — good enough for one rebuild pass.
function searchAllDocs(index: MiniSearch<SearchDoc>): SearchDoc[] {
  const results = index.search(MiniSearch.wildcard) as Array<
    SearchResultLike & Record<string, unknown>
  >;
  const docs: SearchDoc[] = [];
  for (const result of results) {
    const doc: SearchDoc = {
      id: String(result.id),
      name: typeof result.name === "string" ? result.name : "",
      isFolder: result.isFolder === true,
      parentId: typeof result.parentId === "string" ? result.parentId : "",
      mimeType: typeof result.mimeType === "string" ? result.mimeType : "",
    };
    if (typeof result.size === "number") doc.size = result.size;
    if (typeof result.modifiedTime === "string")
      doc.modifiedTime = result.modifiedTime;
    docs.push(doc);
  }
  return docs;
}

interface SearchResultLike {
  id: unknown;
  score: number;
}

// BFS from the configured roots over the adjacency map. A root id that does
// not exist as an INDEXED DOC is still a valid BFS seed when some doc names
// it as its parent (the Drive sentinel "root" is not a file row — My Drive's
// top-level items carry parentId="root" without any row id="root"); the BFS
// simply starts from its children. A root with neither a doc nor children is
// skipped silently. Overlap between roots dedupes through the visited set.
// Unreachable docs (orphans, cycles) never get visited — fail closed.
export function computeRootMembership(
  index: MiniSearch<SearchDoc>,
  parentToChildren: Map<string, Set<string>>,
  rootIds: string[],
): Set<string> {
  const docsById = docsByIdFromIndex(index);
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const rootId of rootIds) {
    if (visited.has(rootId)) continue;
    if (docsById.has(rootId)) {
      visited.add(rootId);
      queue.push(rootId);
      continue;
    }
    // Sentinel-style root: not a doc itself, but its direct children
    // (parentId === rootId) are the BFS frontier.
    const children = parentToChildren.get(rootId);
    if (!children) continue;
    visited.add(rootId);
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) continue;
    const children = parentToChildren.get(current);
    if (!children) continue;
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return visited;
}

// BFS from ONE folder: its full descendant set, itself included (callers that
// must exclude the folder delete its id from the returned set).
export function computeSubtreeIds(
  parentToChildren: Map<string, Set<string>>,
  folderId: string,
): Set<string> {
  const visited = new Set<string>();
  const queue = [folderId];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    const children = parentToChildren.get(current);
    if (!children) continue;
    for (const child of children) {
      if (!visited.has(child)) queue.push(child);
    }
  }
  return visited;
}

function docsByIdFromIndex(
  index: MiniSearch<SearchDoc>,
): Map<string, SearchDoc> {
  const docs = new Map<string, SearchDoc>();
  for (const doc of searchAllDocs(index)) {
    docs.set(doc.id, doc);
  }
  return docs;
}

// ---- Sorting (B3) ----------------------------------------------------------
// Sorts the FULL filtered result set BEFORE the caller slices to the limit.
// Folders-first always (never flipped by dir); direction only affects the
// chosen field. No mutation: returns a fresh array (MiniSearch returns a
// fresh results array per search, but the copy keeps that assumption local).
function sortResults(
  results: SearchResultLike[],
  index: MiniSearch<SearchDoc>,
  sort: SearchSortSpec,
): SearchResultLike[] {
  if (sort.field === "relevance") {
    // Relevance keeps MiniSearch's byScore order but partitions folders first
    // (B4). Stable partition: no re-sort, so the score order inside each
    // group is exactly the engine's, and equal scores never wobble.
    const folders: SearchResultLike[] = [];
    const files: SearchResultLike[] = [];
    for (const result of results) {
      const stored = index.getStoredFields(result.id);
      if (stored?.isFolder === true) folders.push(result);
      else files.push(result);
    }
    return [...folders, ...files];
  }
  const storedById = new Map<string, Record<string, unknown>>();
  const storedOf = (id: string): Record<string, unknown> => {
    const cached = storedById.get(id);
    if (cached) return cached;
    const stored = index.getStoredFields(id) ?? {};
    storedById.set(id, stored);
    return stored;
  };
  return [...results].sort((a, b) => {
    const aId = String(a.id);
    const bId = String(b.id);
    const aStored = storedOf(aId);
    const bStored = storedOf(bId);
    // Folders first in EVERY direction.
    const aFolder = aStored.isFolder === true;
    const bFolder = bStored.isFolder === true;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    const dirFactor = sort.dir === "desc" ? -1 : 1;
    switch (sort.field) {
      case "name": {
        const nameA = typeof aStored.name === "string" ? aStored.name : "";
        const nameB = typeof bStored.name === "string" ? bStored.name : "";
        return compareNatural(nameA, nameB) * dirFactor;
      }
      case "modifiedTime": {
        // Invalid/missing dates pin to the bottom in BOTH directions; the
        // direction multiplies only the delta between two valid dates (same
        // direction-aware pattern as FullRecentView.sortRecentTracks).
        const aValid = isFiniteDateString(aStored.modifiedTime);
        const bValid = isFiniteDateString(bStored.modifiedTime);
        if (!aValid && !bValid) return 0;
        if (!aValid) return 1;
        if (!bValid) return -1;
        const aTime = new Date(aStored.modifiedTime as string).getTime();
        const bTime = new Date(bStored.modifiedTime as string).getTime();
        return (aTime - bTime) * dirFactor;
      }
      case "size": {
        // Valid = a real, finite, non-negative byte count (B6). Missing rows,
        // NaN, ±Infinity and negatives are all "invalid" — they pin to the
        // bottom in BOTH directions instead of corrupting the comparator with
        // a NaN delta.
        const aSize = validSize(aStored.size);
        const bSize = validSize(bStored.size);
        // Missing/invalid sizes pin to the bottom in BOTH directions.
        if (aSize === null && bSize === null) return 0;
        if (aSize === null) return 1;
        if (bSize === null) return -1;
        return (aSize - bSize) * dirFactor;
      }
      default:
        return 0;
    }
  });
}

function isFiniteDateString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed);
}

// Size is sortable only when it is a real, finite, non-negative number. Zero
// IS valid (an empty file); NaN/±Infinity/negatives are not.
function validSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function queryIndex(
  index: MiniSearch<SearchDoc>,
  query: string,
  limit: number,
  scope?: SearchQueryScope,
  sort?: SearchSortSpec,
): SearchHit[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  // Root scope resolution (B1/B2): a scope is MANDATORY — there is no
  // unscoped global path left, so a caller that forgets it fails closed
  // instead of leaking the whole library. An EMPTY rootIds likewise fails
  // closed (present but zero valid roots).
  if (scope === undefined) return [];
  const parentToChildren =
    scope.parentToChildren ?? buildParentToChildren(index);
  const inRootIds =
    scope.inRootIds ??
    (scope.rootIds.length === 0
      ? new Set<string>()
      : computeRootMembership(index, parentToChildren, scope.rootIds));
  if (inRootIds.size === 0) return [];
  let filterIds: Set<string> | null = null;
  if (scope.mode === "recursive") {
    // VIRTUAL_ROOT is the one recursive scope that intentionally means "every
    // configured root" (the synthetic multi-root container has no subtree).
    if (scope.currentFolderId === VIRTUAL_ROOT_ID) {
      // filterIds stays null → the root membership is the whole scope.
    } else if (
      scope.currentFolderId === undefined ||
      scope.currentFolderId === ""
    ) {
      // FAIL CLOSED: recursive mode without a folder id is a caller bug (a
      // frame lost its context). Degrading to the global root scope would
      // silently widen the user's search beyond the folder they are in.
      return [];
    } else {
      // The current folder MUST itself be inside the configured roots (B3).
      // An ancestor that lives outside every root (but happens to contain a
      // configured root deeper down) must not resurrect scoped results: the
      // intersection of its subtree with the roots is not the user's scope.
      if (!inRootIds.has(scope.currentFolderId)) return [];
      // Recursive mode narrows the root scope to the current folder's
      // subtree. The current folder itself is NOT part of the results — only
      // its descendants (the UI shows it as the container, not a hit).
      const subtree = computeSubtreeIds(
        parentToChildren,
        scope.currentFolderId,
      );
      subtree.delete(scope.currentFolderId);
      filterIds = subtree;
      if (filterIds.size === 0) return [];
    }
  }

  // MiniSearch filter option (verified: node_modules/minisearch/dist/es/
  // index.js:1295-1301 — the filter runs while results are being assembled,
  // BEFORE the byScore sort at :1307 and before the engine's own slice, so
  // out-of-root docs can never consume a limit slot).
  const filter = filterIds
    ? (result: { id: unknown }): boolean => {
        const id = String(result.id);
        return inRootIds.has(id) && filterIds.has(id);
      }
    : (result: { id: unknown }): boolean => inRootIds.has(String(result.id));

  const results = index.search(tokens.join(" "), {
    combineWith: "AND",
    prefix: true,
    fuzzy: FUZZY,
    filter,
  });

  // Default (no sort spec) is relevance — the same folders-first partition as
  // an explicit {field:"relevance"}, so the two paths can never diverge.
  const sorted = sortResults(results, index, sort ?? DEFAULT_RELEVANCE);

  return sorted.slice(0, Math.max(0, limit)).map((result) => {
    // MiniSearch types stored fields as Record<string, unknown> (v7.2.0), so
    // the typed getter + typeof narrowing keeps this mapping strict-lint
    // clean.
    const stored = index.getStoredFields(result.id);
    const name = typeof stored?.name === "string" ? stored.name : "";
    const isFolder = stored?.isFolder === true;
    const storedTitle =
      typeof stored?.title === "string" ? stored.title : undefined;
    const storedArtist =
      typeof stored?.artist === "string" ? stored.artist : undefined;

    const hit: SearchHit = {
      id: String(result.id),
      score: result.score,
      name,
      isFolder,
      // Real title when present; else filename minus extension (folders keep
      // their full name).
      title: storedTitle ?? (isFolder ? name : stripExtension(name)),
      artist: storedArtist ?? null,
      parentId: typeof stored?.parentId === "string" ? stored.parentId : "",
      mimeType: typeof stored?.mimeType === "string" ? stored.mimeType : "",
    };
    if (typeof stored?.size === "number") hit.size = stored.size;
    if (typeof stored?.modifiedTime === "string")
      hit.modifiedTime = stored.modifiedTime;
    return hit;
  });
}

export function matchesNormalized(text: string, query: string): boolean {
  if (query.trim() === "") return false;
  const tokens = tokenizeQuery(query);
  // Substring semantics on the normalized text keep the old small-list
  // behavior: every query token must appear (AND), anywhere in the string.
  const normalizedText = normalizeText(text);
  return tokens.every((token) => normalizedText.includes(token));
}
