import MiniSearch from "minisearch";
import { normalizeText } from "../utils/normalizeText";
import {
  METADATA_KEY_PREFIX,
  V_PLACEHOLDER,
  type CachedMetadata,
} from "../utils/metadata";
import { CACHE_VERSION } from "../utils/metadata/constants";
import { stripExtension } from "../utils/metadata/pipelineHelpers";
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

// Name matches matter most, then real ID3 title, then artist (plan: exact >
// prefix > fuzzy; name > title > artist).
const NAME_BOOST = 3;
const TITLE_BOOST = 2;
const ARTIST_BOOST = 1.5;
// Fractional fuzziness: max edit distance = 20% of the term length.
const FUZZY = 0.2;
// Only metadataCache entries with this entry.version are candidates
// (constants.ts CACHE_VERSION, shared with cache.ts).

interface MetadataCacheEntryShape {
  version: number;
  data: CachedMetadata;
}

// Defensive narrowing of the `unknown` metadataCache entry (db.ts:
// MetadataCacheRow.entry). Malformed rows (non-object, wrong version, missing
// data.v, v >= placeholder) are skipped — never thrown on.
function isRealCacheEntry(entry: unknown): entry is MetadataCacheEntryShape {
  if (typeof entry !== "object" || entry === null) return false;
  if (!("version" in entry)) return false;
  if (entry.version !== CACHE_VERSION) return false;
  if (!("data" in entry)) return false;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return false;
  if (!("v" in data)) return false;
  // v:9 placeholders (metadata.ts V_PLACEHOLDER) are NOT real metadata and
  // must never be indexed/searchable (plan Global Constraints).
  return typeof data.v === "number" && data.v < V_PLACEHOLDER;
}

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

export function queryIndex(
  index: MiniSearch<SearchDoc>,
  query: string,
  limit: number,
): SearchHit[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const results = index.search(tokens.join(" "), {
    combineWith: "AND",
    prefix: true,
    fuzzy: FUZZY,
  });

  return results.slice(0, Math.max(0, limit)).map((result) => {
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
