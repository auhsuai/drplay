export type FolderFetchGuard = {
  start: () => number;
  isLatest: (id: number) => boolean;
};

export function createFolderFetchGuard(): FolderFetchGuard {
  let latest = 0;
  return {
    start: () => {
      latest += 1;
      return latest;
    },
    isLatest: (id: number) => id === latest,
  };
}
