import { get, set, keys } from 'idb-keyval';
import { Track } from '../App';

const BASE_RECENT_KEY = 'drplay_recent_tracks';
const BASE_COUNTS_KEY = 'drplay_play_counts';
const BASE_FOLDER_VISITS_KEY = 'drplay_folder_visits';

function getUserKey(baseKey: string) {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${baseKey}_${email}` : baseKey;
}

export interface PlayCountEntry {
  track: Track;
  count: number;
}

export interface FolderVisitEntry {
  id: string;
  name: string;
  count: number;
  lastVisited: number;
}

export async function recordPlay(track: Track) {
  let recents: Track[] = await get(getUserKey(BASE_RECENT_KEY)) || [];
  recents = recents.filter(t => t.id !== track.id);
  recents.unshift(track);
  if (recents.length > 1000) recents = recents.slice(0, 1000);
  await set(getUserKey(BASE_RECENT_KEY), recents);

  const counts: Record<string, PlayCountEntry> = await get(getUserKey(BASE_COUNTS_KEY)) || {};
  if (!counts[track.id]) {
    counts[track.id] = { track, count: 0 };
  }
  counts[track.id].count += 1;
  counts[track.id].track = track;
  await set(getUserKey(BASE_COUNTS_KEY), counts);
  
  window.dispatchEvent(new Event('recent-updated'));
}

export async function getRecentlyPlayed(): Promise<Track[]> {
  return (await get(getUserKey(BASE_RECENT_KEY))) || [];
}

export async function getHeavyRotation(): Promise<Track[]> {
  const counts: Record<string, PlayCountEntry> = await get(getUserKey(BASE_COUNTS_KEY)) || {};
  return Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .map(entry => entry.track)
    .slice(0, 10);
}

export async function getRandomDiscoveries(): Promise<Track[]> {
  const allKeys = await keys();
  const metadataKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('metadata_'));
  
  const shuffled = metadataKeys.sort(() => 0.5 - Math.random());
  const selectedKeys = shuffled.slice(0, 12);
  
  const tracks: Track[] = [];
  for (const key of selectedKeys) {
    const id = (key as string).replace('metadata_', '');
    tracks.push({
      id,
      title: "Audio Track",
      artist: "",
      streamUrl: ""
    });
  }
  return tracks;
}

export async function recordFolderVisit(folderId: string, folderName: string) {
  if (folderId === 'root') return; // Don't track root folder
  const visits: Record<string, FolderVisitEntry> = await get(getUserKey(BASE_FOLDER_VISITS_KEY)) || {};
  if (!visits[folderId]) {
    visits[folderId] = { id: folderId, name: folderName, count: 0, lastVisited: Date.now() };
  }
  visits[folderId].count += 1;
  visits[folderId].name = folderName;
  visits[folderId].lastVisited = Date.now();
  await set(getUserKey(BASE_FOLDER_VISITS_KEY), visits);
}

export async function getMostVisitedFolders(): Promise<FolderVisitEntry[]> {
  const visits: Record<string, FolderVisitEntry> = await get(getUserKey(BASE_FOLDER_VISITS_KEY)) || {};
  return Object.values(visits)
    .sort((a, b) => b.count - a.count || b.lastVisited - a.lastVisited)
    .slice(0, 4);
}
