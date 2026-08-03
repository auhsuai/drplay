// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { PremiumCard } from './PremiumCard';
import { getTrackMetadata } from '../../../utils/metadata';
import type { Track } from '../../../App';

vi.mock('../../../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock('../../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

import { captureError } from '../../../utils/errorLog';

const mockedFetch = vi.mocked(getTrackMetadata);
const mockedCaptureError = vi.mocked(captureError);

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    title: 'My Song',
    artist: '',
    streamUrl: '',
    size: 1000,
    originalName: 'my song.mp3',
    ...over,
  };
}

function baseProps(over: Partial<Parameters<typeof PremiumCard>[0]> = {}) {
  return {
    track: makeTrack(),
    onPlay: () => {},
    token: 'tok',
    ...over,
  };
}

describe('PremiumCard metadata render', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: 'Fetched Artist',
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders fetched title and artist from metadata', async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    expect(mockedFetch).toHaveBeenCalledWith('track-1', 'tok', 1000, 'my song.mp3', expect.any(Object));
    await screen.findByText('Fetched Title');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows fallback placeholder when no cover data resolves', async () => {
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: 'Fetched Artist',
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    const { container } = render(<PremiumCard {...baseProps()} />);
    await screen.findByText('Fetched Title');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('PremiumCard blob URL lifecycle (create in async .then, revoke exactly-once)', () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies once so the card's blob
  // URL lifecycle can be asserted (same pattern as SongCard.test.tsx).
  beforeAll(() => {
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
  });

  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

  function metadataWithPicture(): never {
    return {
      title: 'Blob Track',
      artist: 'Blob Artist',
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureFormat: 'image/png',
    } as never;
  }

  function deferred() {
    let resolve!: (value: never) => void;
    const promise = new Promise<never>((res) => { resolve = res; });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-premium-cover');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  async function flushMicrotasks() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('revokes exactly once per created URL on normal mount -> unmount', async () => {
    const d = deferred();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await act(async () => { d.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('creates no blob URL when metadata resolves after unmount and keeps create === revoke', async () => {
    const d = deferred();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    unmount();
    cleanup();

    await act(async () => { d.resolve(metadataWithPicture()); });
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('revokes every blob URL exactly once when track.id changes while a cover is displayed', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const { rerender, unmount } = render(<PremiumCard {...baseProps()} />);

    await act(async () => { d1.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    rerender(<PremiumCard {...baseProps({
      track: makeTrack({ id: 'track-2', title: 'Other Song', size: 2000, originalName: 'other.mp3' }),
    })} />);
    await act(async () => { d2.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('stale fetch resolving after a token change never creates a URL; new fetch balances create === revoke', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const { rerender, unmount } = render(<PremiumCard {...baseProps()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    rerender(<PremiumCard {...baseProps({ token: 'tok2' })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));

    // stale (first) fetch resolves AFTER the newer one — it must not create a URL
    await act(async () => { d2.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    await act(async () => { d1.resolve(metadataWithPicture()); });
    await flushMicrotasks();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('rapid track.id + token changes with interleaved resolution still keep create === revoke', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    const { rerender, unmount } = render(<PremiumCard {...baseProps()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    rerender(<PremiumCard {...baseProps({ track: makeTrack({ id: 'track-2' }), token: 'tok2' })} />);
    rerender(<PremiumCard {...baseProps({ track: makeTrack({ id: 'track-3' }), token: 'tok3' })} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(3));

    await act(async () => { d3.resolve(metadataWithPicture()); });
    await act(async () => { d1.resolve(metadataWithPicture()); });
    await act(async () => { d2.resolve(metadataWithPicture()); });
    await flushMicrotasks();

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });
});

describe('PremiumCard metadata rejection handling (abort-skip + captureError)', () => {
  function deferredRejectable() {
    let resolve!: (value: never) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<never>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedCaptureError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('calls captureError with module context when metadata fetch rejects while mounted (no unhandled rejection)', async () => {
    mockedFetch.mockRejectedValue(new Error('boom'));

    render(<PremiumCard {...baseProps()} />);

    await waitFor(() => expect(mockedCaptureError).toHaveBeenCalledTimes(1));
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'PremiumCard',
        message: expect.stringContaining('metadata-load-failed'),
      })
    );
  });

  it('skips captureError when the fetch rejects after unmount (deliberate cleanup abort)', async () => {
    const d = deferredRejectable();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    unmount();
    cleanup();

    await act(async () => { d.reject(new Error('aborted')); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });
});
