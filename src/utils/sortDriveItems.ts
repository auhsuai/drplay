import type { DriveItem } from '../App';

// Module-level singleton: options never vary, so there's no reason to
// allocate a fresh Intl.Collator on every sortDriveItems() call (which
// happens on every folder-content re-render via App.tsx's useMemo).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortDriveItems(
  dbFiles: any[],
  sortOption: string,
  currentFolderName: string,
): DriveItem[] {
  const items: DriveItem[] = dbFiles.map(file => {
    const title = file.isFolder ? file.name : file.name.replace(/\.[^/.]+$/, "");
    return {
      id: file.id,
      title,
      isFolder: file.isFolder,
      size: file.size,
      modifiedTime: file.modifiedTime,
      trackInfo: file.isFolder ? undefined : {
        id: file.id,
        title,
        artist: "",
        streamUrl: "",
        size: file.size,
        originalName: file.name,
        parentId: file.parentId,
        parentName: currentFolderName,
      }
    };
  });

  return items.sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;

    switch (sortOption) {
      case 'name': return collator.compare(a.title, b.title);
      case 'name desc': return collator.compare(b.title, a.title);
      case 'modifiedTime': {
        const tA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
        const tB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
        if (tA === tB) return collator.compare(a.title, b.title);
        return tA - tB;
      }
      case 'modifiedTime desc': {
        const tA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
        const tB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
        if (tA === tB) return collator.compare(a.title, b.title);
        return tB - tA;
      }
      case 'size': {
        const diff = (a.size || 0) - (b.size || 0);
        if (diff === 0) return collator.compare(a.title, b.title);
        return diff;
      }
      case 'size desc': {
        const diff = (b.size || 0) - (a.size || 0);
        if (diff === 0) return collator.compare(a.title, b.title);
        return diff;
      }
      default: return collator.compare(a.title, b.title);
    }
  });
}
