// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderSelectionScreen } from './FolderSelectionScreen';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('lucide-react', () => {
  const icons = ['Folder', 'ArrowLeft', 'HardDrive', 'Check', 'Search', 'Loader2'];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  driveApi: {
    listFolderChildren: vi.fn(),
    searchFolders: vi.fn(),
    getFileParents: vi.fn(),
    getFileName: vi.fn(),
  },
  getValidToken: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock('../../utils/driveApi', () => mocks.driveApi);
vi.mock('../../utils/drivePagination', () => ({
  listFolderChildren: mocks.driveApi.listFolderChildren,
  searchFolders: mocks.driveApi.searchFolders,
}));
vi.mock('../../utils/apiClient', () => ({ getValidToken: mocks.getValidToken }));
vi.mock('../../utils/simpleToast', () => ({ showErrorToast: mocks.showErrorToast }));
vi.mock('../../utils/errorLog', () => ({ captureError: mocks.captureError }));
vi.mock('../../db/db', () => {
  const chain = {
    equals: () => chain,
    filter: () => chain,
    toArray: () => Promise.resolve([]),
  };
  return { db: { files: { where: () => chain } } };
});

type DeferredCall = {
  resolve: (value: Array<{ id: string; name: string }>) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
};

let deferredCalls: DeferredCall[] = [];

function installListFolderChildrenMock() {
  mocks.driveApi.listFolderChildren.mockImplementation(
    (_token: string, _folderId: string, signal?: AbortSignal) =>
      new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
        deferredCalls.push({ resolve, reject, signal });
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      })
  );
}

const BACK_BUTTON_INDEX = 0;

function renderScreen() {
  return render(
    <FolderSelectionScreen
      token="test-token"
      onSelectFolder={vi.fn()}
      initialFolderId="folderB"
      initialFolderHistory={[{ id: 'root', name: 'My Drive' }]}
    />
  );
}

describe('FolderSelectionScreen', () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue('test-token');
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the latest folder listing when an older slower fetch resolves after navigation (race)', async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    fireEvent.click(screen.getAllByRole('button')[BACK_BUTTON_INDEX]);
    await waitFor(() => expect(deferredCalls).toHaveLength(2));

    const newFolderFetch = deferredCalls[1];
    await act(async () => {
      newFolderFetch.resolve([{ id: 'f1', name: 'Folder 1' }]);
    });
    expect(screen.queryByText('Folder 1')).not.toBeNull();

    const staleFolderFetch = deferredCalls[0];
    expect(staleFolderFetch.signal?.aborted).toBe(true);
    await act(async () => {
      staleFolderFetch.resolve([{ id: 'stale', name: 'STALE' }]);
    });
    expect(screen.queryByText('STALE')).toBeNull();
    expect(screen.queryByText('Folder 1')).not.toBeNull();
  });

  it('aborts the in-flight fetch on unmount and never updates state afterward', async () => {
    const { unmount } = renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    unmount();

    const inFlight = deferredCalls[0];
    expect(inFlight.signal?.aborted).toBe(true);

    await act(async () => {
      inFlight.resolve([{ id: 'late', name: 'LATE' }]);
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it('does not toast when the in-flight folder fetch is aborted by navigation', async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    fireEvent.click(screen.getAllByRole('button')[BACK_BUTTON_INDEX]);
    await waitFor(() => expect(deferredCalls).toHaveLength(2));

    await act(async () => {
      deferredCalls[0].reject(new DOMException('The operation was aborted', 'AbortError'));
      deferredCalls[1].resolve([{ id: 'f1', name: 'Folder 1' }]);
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('failed-to-fetch-folders') })
    );
    expect(screen.queryByText('Folder 1')).not.toBeNull();
  });

  it('guards the localStorage root-folder read: SecurityError → warn + fallback null (no crash)', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage blocked', 'SecurityError');
    });
    try {
      render(
        <FolderSelectionScreen
          token="test-token"
          onSelectFolder={vi.fn()}
          initialFolderId="folderB"
          initialFolderHistory={[{ id: 'root', name: 'My Drive' }]}
        />
      );
      // Component still mounts and starts the normal folder fetch.
      await waitFor(() => expect(deferredCalls).toHaveLength(1));
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'FolderSelectionScreen',
          message: expect.stringContaining('root-folder-read-failed'),
        })
      );
    } finally {
      getItemSpy.mockRestore();
    }
  });
});
