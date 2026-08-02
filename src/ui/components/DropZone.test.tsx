// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropZone } from './DropZone';
import { useDriveStore } from '../../store/driveStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('lucide-react', () => ({
  // CloudUpload is the canonical lucide export for "cloud-upload";
  // UploadCloud is the deprecated alias (removed in a future lucide major).
  CloudUpload: mocks.lucideCloudUpload,
}));

const mocks = vi.hoisted(() => ({
  getCurrentWebview: vi.fn(),
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
  statDiskPath: vi.fn(),
  startUploads: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
  lucideCloudUpload: vi.fn((_props: { className?: string }) => null),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: mocks.getCurrentWebview,
}));
vi.mock('../../utils/diskFs', () => ({ statDiskPath: mocks.statDiskPath }));
vi.mock('../../utils/uploadManager', () => ({ startUploads: mocks.startUploads }));
vi.mock('../../utils/simpleToast', () => ({ showErrorToast: mocks.showErrorToast }));
vi.mock('../../utils/errorLog', () => ({ captureError: mocks.captureError }));

const OVERLAY_TESTID = 'drop-overlay';
const DROP_FAILED_TOAST = 'upload.drop_failed';
const OVERLAY_TEXT = 'upload.drop_overlay';

interface DropPayload {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}

let capturedHandler: ((event: { payload: DropPayload }) => void) | null = null;

function emit(event: { payload: DropPayload }): void {
  const handler = capturedHandler;
  if (!handler) throw new Error('drag-drop handler not registered');
  act(() => handler(event));
}

describe('DropZone', () => {
  beforeEach(() => {
    capturedHandler = null;
    mocks.getCurrentWebview.mockReset();
    mocks.onDragDropEvent.mockReset();
    mocks.unlisten.mockReset();
    mocks.statDiskPath.mockReset();
    mocks.startUploads.mockReset();
    mocks.showErrorToast.mockReset();
    mocks.captureError.mockReset();
    mocks.getCurrentWebview.mockReturnValue({ onDragDropEvent: mocks.onDragDropEvent });
    mocks.onDragDropEvent.mockImplementation(async (handler: (event: unknown) => void) => {
      capturedHandler = handler as (event: { payload: DropPayload }) => void;
      return mocks.unlisten;
    });
    mocks.lucideCloudUpload.mockReset();
    useDriveStore.setState({ currentFolderId: 'root' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('registers the drag-drop listener when a token is present and unlistens on unmount', async () => {
    const { unmount } = render(<DropZone token="tok-1" />);
    await waitFor(() => expect(mocks.onDragDropEvent).toHaveBeenCalledTimes(1));
    expect(mocks.getCurrentWebview).toHaveBeenCalledTimes(1);
    await act(async () => {});
    unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledTimes(1));
  });

  it('does not register the listener when there is no token', () => {
    render(<DropZone token={null} />);
    expect(mocks.getCurrentWebview).not.toHaveBeenCalled();
    expect(mocks.onDragDropEvent).not.toHaveBeenCalled();
  });

  it('does not crash when getCurrentWebview throws (outside Tauri), and logs a warn', async () => {
    mocks.getCurrentWebview.mockImplementation(() => {
      throw new Error('__TAURI_INTERNALS__ is undefined');
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() =>
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'DropZone', level: 'warn', message: expect.stringContaining('drag-drop-listener-failed') })
      )
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it('does not crash when onDragDropEvent rejects, and logs a warn', async () => {
    mocks.onDragDropEvent.mockRejectedValue(new Error('listen failed'));
    render(<DropZone token="tok-1" />);
    await waitFor(() =>
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'DropZone', level: 'warn', message: expect.stringContaining('drag-drop-listener-failed') })
      )
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it('shows the overlay on over and hides it on leave', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'over', position: { x: 10, y: 20 } } });
    expect(screen.getByTestId(OVERLAY_TESTID)).toBeTruthy();
    expect(screen.getByText(OVERLAY_TEXT)).toBeTruthy();
    emit({ payload: { type: 'leave' } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it('shows the overlay on enter (Tauri emits enter before over)', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'enter', paths: ['C:\\Music\\a.mp3'], position: { x: 1, y: 1 } } });
    expect(screen.getByTestId(OVERLAY_TESTID)).toBeTruthy();
  });

  it('keeps the overlay stable across repeated over events (no flicker)', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'over', position: { x: 1, y: 1 } } });
    emit({ payload: { type: 'over', position: { x: 2, y: 2 } } });
    expect(screen.getByTestId(OVERLAY_TESTID)).toBeTruthy();
  });

  it('renders the overlay with pointer-events-none and full-window styling', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'over', position: { x: 1, y: 1 } } });
    const overlay = screen.getByTestId(OVERLAY_TESTID);
    expect(overlay.className).toContain('pointer-events-none');
    expect(overlay.className).toContain('fixed');
    expect(overlay.className).toContain('z-[10000]');
  });

  it('renders the overlay icon with the canonical CloudUpload (not deprecated UploadCloud) and the agreed sizing classes', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'over', position: { x: 1, y: 1 } } });
    // The lucide-react mock records the icon component actually rendered.
    expect(mocks.lucideCloudUpload).toHaveBeenCalledTimes(1);
    const props = mocks.lucideCloudUpload.mock.calls[0][0] as { className?: string };
    expect(props.className).toContain('w-12');
    expect(props.className).toContain('h-12');
    expect(props.className).toContain('text-white');
  });

  it('uploads a dropped file into the current folder', async () => {
    useDriveStore.setState({ currentFolderId: 'folder-1' });
    mocks.statDiskPath.mockResolvedValue({ path: 'C:\\Music\\a.mp3', name: 'a.mp3', relativePath: 'a.mp3', isDirectory: false, size: 10 });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\Music\\a.mp3'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [{ name: 'a.mp3', isFolder: false, parentId: 'folder-1', diskPath: 'C:\\Music\\a.mp3' }],
      'tok-1'
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it('uploads a dropped folder with isFolder true', async () => {
    mocks.statDiskPath.mockResolvedValue({ path: 'C:\\Music\\Album', name: 'Album', relativePath: 'Album', isDirectory: true, size: 0 });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\Music\\Album'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [{ name: 'Album', isFolder: true, parentId: 'root', diskPath: 'C:\\Music\\Album' }],
      'tok-1'
    );
  });

  it('groups a mixed drop (file + folder) into a single startUploads call', async () => {
    mocks.statDiskPath.mockImplementation(async (path: string) => ({
      path,
      name: path.endsWith('Album') ? 'Album' : 'a.mp3',
      relativePath: path.endsWith('Album') ? 'Album' : 'a.mp3',
      isDirectory: path.endsWith('Album'),
      size: path.endsWith('Album') ? 0 : 1,
    }));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\Music\\a.mp3', 'C:\\Music\\Album'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        { name: 'a.mp3', isFolder: false, parentId: 'root', diskPath: 'C:\\Music\\a.mp3' },
        { name: 'Album', isFolder: true, parentId: 'root', diskPath: 'C:\\Music\\Album' },
      ],
      'tok-1'
    );
  });

  it('skips not-found paths and toasts when every dropped path is invalid', async () => {
    mocks.statDiskPath.mockResolvedValue(null);
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\gone\\x.mp3', 'C:\\gone\\album'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith(DROP_FAILED_TOAST));
    expect(mocks.startUploads).not.toHaveBeenCalled();
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'DropZone', level: 'warn', message: expect.stringContaining('drop-path-missing') })
    );
  });

  it('skips a stat-failing path but still uploads the valid ones (no throw)', async () => {
    mocks.statDiskPath.mockImplementation(async (path: string) => {
      if (path.includes('bad')) throw new Error('permission denied');
      return { path, name: 'ok.mp3', relativePath: 'ok.mp3', isDirectory: false, size: 1 };
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\bad\\x.mp3', 'C:\\ok\\ok.mp3'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [{ name: 'ok.mp3', isFolder: false, parentId: 'root', diskPath: 'C:\\ok\\ok.mp3' }],
      'tok-1'
    );
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'DropZone', level: 'warn', message: expect.stringContaining('drop-stat-failed') })
    );
  });

  it('does nothing when the drop payload has no paths', async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: [], position: { x: 1, y: 1 } } });
    expect(mocks.statDiskPath).not.toHaveBeenCalled();
    expect(mocks.startUploads).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('handles a drop without a preceding over (overlay hides, upload proceeds)', async () => {
    mocks.statDiskPath.mockResolvedValue({ path: 'C:\\Music\\b.mp3', name: 'b.mp3', relativePath: 'b.mp3', isDirectory: false, size: 2 });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: 'drop', paths: ['C:\\Music\\b.mp3'], position: { x: 1, y: 1 } } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it('does not upload when the token is gone at drop time', async () => {
    mocks.statDiskPath.mockResolvedValue({ path: 'C:\\Music\\c.mp3', name: 'c.mp3', relativePath: 'c.mp3', isDirectory: false, size: 3 });
    const { rerender } = render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    rerender(<DropZone token={null} />);
    emit({ payload: { type: 'drop', paths: ['C:\\Music\\c.mp3'], position: { x: 1, y: 1 } } });
    expect(mocks.statDiskPath).not.toHaveBeenCalled();
    expect(mocks.startUploads).not.toHaveBeenCalled();
  });
});
