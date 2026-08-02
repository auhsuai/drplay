import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  openDiskReadStream,
  registerUploadPath,
  statDiskPath,
  walkDiskFolder,
} from './diskFs';
import { captureError } from './errorLog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./errorLog', () => ({
  captureError: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const captureErrorMock = vi.mocked(captureError);

// Shape mirrors the real plugin:fs|read_dir response (DirEntry, camelCase).
function dirEntry(name: string, isDirectory: boolean) {
  return { name, isDirectory, isFile: !isDirectory, isSymlink: false };
}

// The mock receives InvokeArgs (Record | raw-body union); read_dir is always
// called with an object arg, so pull the path out of it defensively.
function pathOf(args: unknown): string {
  const path = (args as Record<string, unknown> | undefined)?.path;
  return typeof path === 'string' ? path : '';
}

// Real Rust stat rejection for a missing path (ENOENT), formatted exactly
// like the plugin's commands.rs ("failed to get metadata of path: ... with
// error: ... (os error 2)").
const NOT_FOUND_WINDOWS_MSG =
  'failed to get metadata of path: C:\\nope.mp3 with error: The system cannot find the file specified. (os error 2)';
const NOT_FOUND_UNIX_MSG =
  'failed to get metadata of path: /tmp/nope.mp3 with error: No such file or directory (os error 2)';

beforeEach(() => {
  invokeMock.mockReset();
  captureErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerUploadPath', () => {
  it('calls invoke with the exact Rust command and path arg', async () => {
    invokeMock.mockResolvedValue(undefined);

    await registerUploadPath('C:\\Music\\My Album');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('register_upload_path', {
      path: 'C:\\Music\\My Album',
    });
  });

  it('wraps a scope-denied rejection in a clear Error (no silent swallow)', async () => {
    invokeMock.mockRejectedValue('path forbidden on scope');

    await expect(registerUploadPath('C:\\Music')).rejects.toThrow(
      /Failed to extend fs read scope for "C:\\Music"/
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs', level: 'warn' })
    );
  });
});

describe('statDiskPath', () => {
  it('maps a file stat response to a DiskEntry (size preserved, relativePath = name)', async () => {
    invokeMock.mockResolvedValue({
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      size: 42,
      mtime: 1_700_000_000_000,
    });

    const entry = await statDiskPath('C:\\Music\\song.mp3');

    expect(entry).toEqual({
      path: 'C:\\Music\\song.mp3',
      name: 'song.mp3',
      relativePath: 'song.mp3',
      isDirectory: false,
      size: 42,
    });
  });

  it('reports size 0 for directories', async () => {
    invokeMock.mockResolvedValue({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 4096,
    });

    const entry = await statDiskPath('C:\\Music\\sub');

    expect(entry).not.toBeNull();
    expect(entry!.isDirectory).toBe(true);
    expect(entry!.size).toBe(0);
  });

  it('extracts the basename for paths with a trailing separator', async () => {
    invokeMock.mockResolvedValue({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 0,
    });

    const entry = await statDiskPath('C:\\Music\\');

    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('Music');
    expect(entry!.relativePath).toBe('Music');
  });

  it('returns null (no throw) when the path does not exist (Windows ENOENT)', async () => {
    invokeMock.mockRejectedValue(NOT_FOUND_WINDOWS_MSG);

    await expect(statDiskPath('C:\\nope.mp3')).resolves.toBeNull();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('returns null (no throw) for the Unix ENOENT error wording', async () => {
    invokeMock.mockRejectedValue(NOT_FOUND_UNIX_MSG);

    await expect(statDiskPath('/tmp/nope.mp3')).resolves.toBeNull();
  });

  it('returns null for an Error-wrapped ENOENT rejection', async () => {
    invokeMock.mockRejectedValue(new Error(NOT_FOUND_UNIX_MSG));

    await expect(statDiskPath('/tmp/nope.mp3')).resolves.toBeNull();
  });

  it('throws a wrapped error for non-ENOENT failures (scope/permission denied)', async () => {
    invokeMock.mockRejectedValue('path forbidden on scope');

    await expect(statDiskPath('C:\\Music')).rejects.toThrow(
      /Failed to stat "C:\\Music"/
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs' })
    );
  });

  it('throws a wrapped error for ENOTDIR (os error 20) — not a not-found, must not return null', async () => {
    invokeMock.mockRejectedValue(
      'failed to get metadata of path: C:\\Music\\song.mp3\\extra with error: Not a directory (os error 20)'
    );

    await expect(statDiskPath('C:\\Music\\song.mp3\\extra')).rejects.toThrow(
      /Failed to stat "C:\\Music\\song\.mp3\\extra"/
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs' })
    );
  });

  it('throws a wrapped error for ERROR_DIRECTORY (os error 267, Windows) — not a not-found', async () => {
    invokeMock.mockRejectedValue(
      'failed to get metadata of path: C:\\Music\\song.mp3 with error: The directory name is invalid. (os error 267)'
    );

    await expect(statDiskPath('C:\\Music\\song.mp3')).rejects.toThrow(
      /Failed to stat "C:\\Music\\song\.mp3"/
    );
  });
});

describe('walkDiskFolder', () => {
  const TREE: Record<string, ReturnType<typeof dirEntry>[]> = {
    'C:\\Music': [
      dirEntry('sub', true),
      dirEntry('song1.mp3', false),
      dirEntry('zebra.flac', false),
    ],
    'C:\\Music\\sub': [dirEntry('deep', true), dirEntry('song2.flac', false)],
    'C:\\Music\\sub\\deep': [dirEntry('song3.ogg', false)],
  };

  function mockTree(): void {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'plugin:fs|read_dir') {
        const path = pathOf(args);
        const entries = TREE[path];
        if (!entries) throw new Error(`unknown dir: ${path}`);
        return entries;
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  it('flattens the folder tree recursively, sorted by relativePath, sizes 0', async () => {
    mockTree();

    const entries = await walkDiskFolder('C:\\Music');

    expect(entries).toEqual([
      { path: 'C:\\Music\\song1.mp3', name: 'song1.mp3', relativePath: 'song1.mp3', isDirectory: false, size: 0 },
      { path: 'C:\\Music\\sub', name: 'sub', relativePath: 'sub', isDirectory: true, size: 0 },
      { path: 'C:\\Music\\sub\\deep', name: 'deep', relativePath: 'sub/deep', isDirectory: true, size: 0 },
      { path: 'C:\\Music\\sub\\deep\\song3.ogg', name: 'song3.ogg', relativePath: 'sub/deep/song3.ogg', isDirectory: false, size: 0 },
      { path: 'C:\\Music\\sub\\song2.flac', name: 'song2.flac', relativePath: 'sub/song2.flac', isDirectory: false, size: 0 },
      { path: 'C:\\Music\\zebra.flac', name: 'zebra.flac', relativePath: 'zebra.flac', isDirectory: false, size: 0 },
    ]);
  });

  it('issues one read_dir invoke per directory with the joined path', async () => {
    mockTree();

    await walkDiskFolder('C:\\Music');

    const paths = invokeMock.mock.calls
      .filter((c) => c[0] === 'plugin:fs|read_dir')
      .map((c) => (c[1] as { path: string }).path);
    expect(paths.sort()).toEqual(['C:\\Music', 'C:\\Music\\sub', 'C:\\Music\\sub\\deep']);
  });

  it('handles a root path with a trailing separator (no leading / in relativePath)', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'plugin:fs|read_dir') {
        if (pathOf(args) === 'C:\\Music\\') return [dirEntry('a.mp3', false)];
        return [];
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const entries = await walkDiskFolder('C:\\Music\\');

    expect(entries).toEqual([
      { path: 'C:\\Music\\a.mp3', name: 'a.mp3', relativePath: 'a.mp3', isDirectory: false, size: 0 },
    ]);
  });

  it('returns [] for an empty folder', async () => {
    invokeMock.mockResolvedValue([]);

    const entries = await walkDiskFolder('C:\\Empty');

    expect(entries).toEqual([]);
  });

  it('throws a wrapped error when read_dir rejects (missing path / scope denied)', async () => {
    invokeMock.mockRejectedValue('path forbidden on scope');

    await expect(walkDiskFolder('C:\\Nope')).rejects.toThrow(
      /Failed to read directory "C:\\Nope"/
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs' })
    );
  });

  it('stops descending when a nested read_dir fails, surfacing the wrapped error', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'plugin:fs|read_dir') {
        if (pathOf(args) === 'C:\\Music') return [dirEntry('broken', true)];
        throw 'permission denied for subdirectory';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await expect(walkDiskFolder('C:\\Music')).rejects.toThrow(
      /Failed to read directory "C:\\Music\\broken"/
    );
  });

  it('walks normally when a non-aborted signal is passed (optional param keeps old behavior)', async () => {
    mockTree();
    const controller = new AbortController();

    const entries = await walkDiskFolder('C:\\Music', controller.signal);

    expect(entries).toHaveLength(6);
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'plugin:fs|read_dir')).toHaveLength(3);
  });

  it('throws AbortError immediately for an already-aborted signal (zero read_dir calls)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(walkDiskFolder('C:\\Music', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(invokeMock).not.toHaveBeenCalled();
    // A user cancel is not a disk failure: no error log, no wrap.
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('aborts mid-walk: signal aborted while a nested read_dir is pending → throws AbortError, no further read_dir', async () => {
    let releaseSubDir!: (entries: ReturnType<typeof dirEntry>[]) => void;
    const subDirGate = new Promise<ReturnType<typeof dirEntry>[]>((resolve) => {
      releaseSubDir = resolve;
    });
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'plugin:fs|read_dir') {
        const path = pathOf(args);
        if (path === 'C:\\Music') return Promise.resolve([dirEntry('sub', true)]);
        if (path === 'C:\\Music\\sub') return subDirGate;
        throw new Error(`unknown dir: ${path}`);
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const controller = new AbortController();

    const p = walkDiskFolder('C:\\Music', controller.signal);
    // Let the root read_dir land and the recursion enter the pending subdir read.
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    releaseSubDir([dirEntry('song2.flac', false)]);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    // Root + subdir only — the aborted walk never descends any further.
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'plugin:fs|read_dir')).toHaveLength(2);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

describe('openDiskReadStream', () => {
  const PATH = 'C:\\Music\\big.flac';
  const RID = 42;

  // Mirror the plugin's raw response: chunk bytes followed by the nread count
  // as 8 big-endian bytes (guest-js FileHandle.read convention).
  function arrayBufferPayload(bytes: number[], nread: number): ArrayBuffer {
    const buf = new ArrayBuffer(bytes.length + 8);
    const view = new DataView(buf);
    new Uint8Array(buf, 0, bytes.length).set(bytes);
    view.setBigUint64(bytes.length, BigInt(nread), false);
    return buf;
  }

  function numberPayload(bytes: number[], nread: number): number[] {
    const be: number[] = [];
    for (let i = 7; i >= 0; i--) be.push(Math.floor(nread / 256 ** i) % 256);
    return [...bytes, ...be];
  }

  it('opens with the exact invoke shape (path + options.read) and returns a stream', async () => {
    invokeMock.mockResolvedValue(RID);

    const stream = await openDiskReadStream(PATH);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('plugin:fs|open', {
      path: PATH,
      options: { read: true },
    });
    expect(typeof stream.read).toBe('function');
    expect(typeof stream.close).toBe('function');
  });

  it('read() requests len = chunkSize and strips the trailing 8-byte nread', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockResolvedValueOnce(arrayBufferPayload([1, 2, 3, 4], 4));

    const stream = await openDiskReadStream(PATH, 1024);
    const chunk = await stream.read();

    expect(invokeMock).toHaveBeenCalledWith('plugin:fs|read', { rid: RID, len: 1024 });
    expect(chunk).not.toBeNull();
    expect(Array.from(chunk!)).toEqual([1, 2, 3, 4]);
  });

  it('read() resolves null at EOF (nread = 0)', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockResolvedValueOnce(arrayBufferPayload([], 0));

    const stream = await openDiskReadStream(PATH);
    await expect(stream.read()).resolves.toBeNull();
  });

  it('handles the JSON number[] fallback path with the same nread convention', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockResolvedValueOnce(numberPayload([9, 8, 7], 3));

    const stream = await openDiskReadStream(PATH);
    const chunk = await stream.read();

    expect(chunk).not.toBeNull();
    expect(Array.from(chunk!)).toEqual([9, 8, 7]);
  });

  it('close() invokes the core resources close command with the rid', async () => {
    invokeMock.mockResolvedValue(RID);

    const stream = await openDiskReadStream(PATH);
    await stream.close();

    expect(invokeMock).toHaveBeenCalledWith('plugin:resources|close', { rid: RID });
  });

  it('close() failure is logged, not thrown (finally must not mask primary errors)', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockRejectedValueOnce('close failed');

    const stream = await openDiskReadStream(PATH);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs', level: 'warn' })
    );
  });

  it('open rejection → wrapped error + captureError (no silent swallow)', async () => {
    invokeMock.mockRejectedValue('path forbidden on scope');

    await expect(openDiskReadStream(PATH)).rejects.toThrow(
      /Failed to open file "C:\\Music\\big\.flac"/
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs' })
    );
  });

  it('read rejection → wrapped error + captureError', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockRejectedValueOnce('io error');

    const stream = await openDiskReadStream(PATH);
    await expect(stream.read()).rejects.toThrow(/Failed to read file/);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'diskFs' })
    );
  });

  it('malformed response (< 8 bytes, no nread trailer) → wrapped error', async () => {
    invokeMock.mockResolvedValueOnce(RID);
    invokeMock.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);

    const stream = await openDiskReadStream(PATH);
    await expect(stream.read()).rejects.toThrow(/malformed stream response/);
  });
});
