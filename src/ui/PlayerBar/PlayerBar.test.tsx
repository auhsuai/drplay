// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../App';
import { PlayerBar } from './PlayerBar';
import type { PlayerBarProps } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('lucide-react', () => {
  const icons = [
    'CloudOff', 'FileWarning', 'WifiOff', 'Play', 'Pause', 'SkipBack', 'SkipForward',
    'Volume2', 'Volume1', 'Volume', 'VolumeX', 'Loader2', 'Music', 'Shuffle',
    'Repeat', 'Repeat1', 'Maximize2', 'RefreshCw', 'Heart',
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const { isFavorite, addFavorite, removeFavorite } = vi.hoisted(() => ({
  isFavorite: vi.fn<(trackId: string) => Promise<boolean>>(),
  addFavorite: vi.fn<(track: Track) => Promise<void>>(),
  removeFavorite: vi.fn<(trackId: string) => Promise<void>>(),
}));

vi.mock('../../utils/favorites', () => ({ isFavorite, addFavorite, removeFavorite }));

vi.mock('../components/MoreMenu', () => ({ MoreMenu: () => null }));

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: any) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    getCurrentTime: vi.fn(() => 0),
    getBuffered: vi.fn(),
    seek: vi.fn(),
    playTrack: vi.fn(),
    pause: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    _handlers: {} as Record<string, Handler[]>,
    _emit(event: string, payload?: any) {
      for (const h of fakeController._handlers[event] ?? []) h(payload);
    },
  };
  return { fakeController };
});

function installFakeOn() {
  fakeController.on.mockImplementation((event: string, handler: (payload: any) => void) => {
    (fakeController._handlers[event] ??= []).push(handler);
    return () => {
      fakeController._handlers[event] = (fakeController._handlers[event] ?? []).filter((h) => h !== handler);
    };
  });
}

vi.mock('../../lib/AudioController', () => ({
  AudioController: { getInstance: () => fakeController },
}));

function setBuffered(ranges: Array<[number, number]>, duration = 1000, currentTime = 10) {
  fakeController.getBuffered.mockReturnValue({
    duration,
    currentTime,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    } as TimeRanges,
  });
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    title: 'Song',
    artist: 'Artist',
    streamUrl: '/drive-stream/track-1',
    ...overrides,
  };
}

function renderPlayer(overrides: Partial<PlayerBarProps> = {}) {
  return render(
    <PlayerBar
      currentTrack={makeTrack()}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      onNextTrack={vi.fn()}
      onPrevTrack={vi.fn()}
      playMode="normal"
      onTogglePlayMode={vi.fn()}
      onExpandNowPlaying={vi.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.getBuffered.mockClear();
  installFakeOn();
  setBuffered([]);
  fakeController._handlers = {};
  isFavorite.mockClear();
  addFavorite.mockClear();
  removeFavorite.mockClear();
  isFavorite.mockResolvedValue(false);
  addFavorite.mockResolvedValue(undefined);
  removeFavorite.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe('PlayerBar buffer bar', () => {
  it('BUG regression: renders audio.buffered segments in the buffer bar when AudioController emits progress', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('progress');
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // Future-only buffer: [10,300] of duration 1000 -> 1% / 29%.
    expect(seg.style.left).toBe(`${(10 / 1000) * 100}%`);
    expect(seg.style.width).toBe(`${(290 / 1000) * 100}%`);
  });

  it('BUG regression: timeupdate re-renders the buffer bar from audio.buffered (progress race)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('timeupdate', { currentTime: 10, duration: 1000 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // Future-only buffer: [10,300] of duration 1000 -> 1% / 29%.
    expect(seg.style.left).toBe(`${(10 / 1000) * 100}%`);
    expect(seg.style.width).toBe(`${(290 / 1000) * 100}%`);
  });

  it('BUG regression: buffer container is pinned full-width and transparent (segment children own the background)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    // Container must be pinned to the full progress-bar track (inset-0 / w-full
    // / right-0) — never a shrink-to-fit `absolute left-0` box whose width
    // computes to 0 (CSS2.1 §10.3.7), collapsing the child % segments.
    expect(buffer.className).toMatch(/\b(inset-0|w-full)\b|\bright-0\b/);
    // Container must be transparent — the buffered segment children created by
    // updateBufferBar() (bg-gray-400) are the visible part.
    expect(buffer.className).not.toMatch(/\bbg-/);
  });

  it('BUG regression: forward seek shows only the future buffered segment (pre-seek past range dropped)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 30], [500, 510]], 1000, 505);
    act(() => {
      fakeController._emit('progress');
    });

    // Pre-seek [0,30] ends before currentTime=505 -> dropped entirely; [500,510]
    // is clipped to the future part [505,510]: 50.5% / 0.5% of duration 1000.
    expect(buffer.childElementCount).toBe(1);
    expect((buffer.children[0] as HTMLElement).style.left).toBe('50.5%');
    expect((buffer.children[0] as HTMLElement).style.width).toBe('0.5%');
  });

  it('BUG regression: a fully-past buffered range is dropped while a range straddling the playhead is clipped', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 100], [200, 300]], 1000, 250);
    act(() => {
      fakeController._emit('progress');
    });

    // [0,100] ends before currentTime=250 -> dropped; [200,300] straddles the
    // playhead -> only the future part [250,300] renders: 25% / 5% of 1000.
    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe('25%');
    expect(seg.style.width).toBe('5%');
  });

  it('clears the buffer bar when switching to a new track', () => {
    const { rerender } = renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('progress');
    });
    expect(buffer.childElementCount).toBe(1);

    rerender(
      <PlayerBar
        currentTrack={makeTrack({ id: 'track-2' })}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />
    );
    expect(buffer.childElementCount).toBe(0);
  });

  it('unsubscribes the progress handler on unmount (no listener leak)', () => {
    const { unmount } = renderPlayer();
    expect(fakeController._handlers['progress'] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers['progress'] ?? []).toHaveLength(0);
  });
});

describe('PlayerBar seek-drag (parity with useNowPlayingProgress)', () => {
  beforeEach(() => {
    fakeController.seek.mockClear();
  });

  function dragBar() {
    const bar = screen.getByTestId('buffer-fill').parentElement as HTMLElement;
    const rect = { left: 0, right: 200, top: 0, bottom: 10, width: 200, height: 10, x: 0, y: 0, toJSON: () => {} } as DOMRect;
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect);
    return bar;
  }

  it('BUG regression: updates the time text live while dragging (not only on commit)', () => {
    renderPlayer();
    act(() => {
      fakeController._emit('timeupdate', { currentTime: 0, duration: 240 });
    });

    const bar = dragBar();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(screen.getByText('1:00')).toBeTruthy();

    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    expect(screen.getByText('2:00')).toBeTruthy();

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it('BUG regression: pointercancel commits the seek and removes all window drag listeners (no leak)', () => {
    renderPlayer();
    act(() => {
      fakeController._emit('timeupdate', { currentTime: 0, duration: 240 });
    });

    const bar = dragBar();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerCancel(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);

    // Listeners removed — a late pointerup must not seek again.
    act(() => {
      fireEvent.pointerUp(window, { clientX: 150, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerBar seek clears buffer bar immediately (big-player pattern)', () => {
  beforeEach(() => {
    fakeController.seek.mockClear();
  });

  it('BUG regression: ArrowLeft seek clears the buffer bar synchronously (no stale pre-seek segments)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('progress');
    });
    expect(buffer.childElementCount).toBe(1);

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(buffer.childElementCount).toBe(0);
  });

  it('BUG regression: ArrowRight seek clears the buffer bar synchronously (no stale pre-seek segments)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('progress');
    });
    expect(buffer.childElementCount).toBe(1);

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(buffer.childElementCount).toBe(0);
  });

  it('BUG regression: drag commit (pointerup) clears the buffer bar synchronously after seek', () => {
    renderPlayer();
    act(() => {
      fakeController._emit('timeupdate', { currentTime: 0, duration: 240 });
    });
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit('progress');
    });
    expect(buffer.childElementCount).toBe(1);

    const bar = buffer.parentElement as HTMLElement;
    const rect = { left: 0, right: 200, top: 0, bottom: 10, width: 200, height: 10, x: 0, y: 0, toJSON: () => {} } as DOMRect;
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect);
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
    expect(buffer.childElementCount).toBe(0);
  });
});

describe('PlayerBar favorite (heart) button', () => {
  it('checks favorite status for the current track and renders the heart button (not liked)', async () => {
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Add to favorites' });
    expect(btn).toBeTruthy();
    expect(isFavorite).toHaveBeenCalledWith('track-1');
  });

  it('shows the liked state (remove aria-label + filled class) when isFavorite resolves true', async () => {
    isFavorite.mockResolvedValue(true);
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Remove from favorites' });
    expect(btn.className).toContain('text-[#4285F4]');
  });

  it('calls addFavorite and flips to liked on click when not liked', async () => {
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Add to favorites' });
    fireEvent.click(btn);
    await screen.findByRole('button', { name: 'Remove from favorites' });
    expect(addFavorite).toHaveBeenCalledTimes(1);
    expect(addFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-1' }));
    expect(removeFavorite).not.toHaveBeenCalled();
  });

  it('calls removeFavorite on click when already liked', async () => {
    isFavorite.mockResolvedValue(true);
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Remove from favorites' });
    fireEvent.click(btn);
    await screen.findByRole('button', { name: 'Add to favorites' });
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(removeFavorite).toHaveBeenCalledWith('track-1');
    expect(addFavorite).not.toHaveBeenCalled();
  });

  it('re-checks favorite status when the track id changes', async () => {
    const { rerender } = renderPlayer();
    await screen.findByRole('button', { name: 'Add to favorites' });
    isFavorite.mockClear();

    rerender(
      <PlayerBar
        currentTrack={makeTrack({ id: 'track-2' })}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />
    );
    await screen.findByRole('button', { name: 'Add to favorites' });
    expect(isFavorite).toHaveBeenCalledWith('track-2');
  });

  it('re-checks the current track when favorites-updated fires elsewhere (no stale heart)', async () => {
    renderPlayer();
    await screen.findByRole('button', { name: 'Add to favorites' });
    isFavorite.mockClear();
    isFavorite.mockResolvedValue(true);

    act(() => {
      window.dispatchEvent(new CustomEvent('favorites-updated'));
    });

    expect(isFavorite).toHaveBeenCalledWith('track-1');
    await screen.findByRole('button', { name: 'Remove from favorites' });
  });

  it('does not crash when favorites-updated fires with no current track', async () => {
    const { rerender } = renderPlayer();
    await screen.findByRole('button', { name: 'Add to favorites' });
    isFavorite.mockClear();

    rerender(
      <PlayerBar
        currentTrack={null}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />
    );

    expect(() => {
      act(() => {
        window.dispatchEvent(new CustomEvent('favorites-updated'));
      });
    }).not.toThrow();
    expect(isFavorite).not.toHaveBeenCalled();
  });

  it('ignores a second click while the first toggle is still in flight (no duplicate add)', async () => {
    let resolveAdd: (() => void) | undefined;
    addFavorite.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveAdd = res; })
    );
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Add to favorites' });

    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(addFavorite).toHaveBeenCalledTimes(1);
    act(() => { resolveAdd?.(); });
    await screen.findByRole('button', { name: 'Remove from favorites' });
  });

  it('resets the toggle guard after completion so the next click can remove', async () => {
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Add to favorites' });
    fireEvent.click(btn);
    await screen.findByRole('button', { name: 'Remove from favorites' });
    expect(addFavorite).toHaveBeenCalledTimes(1);

    const removeBtn = screen.getByRole('button', { name: 'Remove from favorites' });
    fireEvent.click(removeBtn);
    await screen.findByRole('button', { name: 'Add to favorites' });
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(removeFavorite).toHaveBeenCalledWith('track-1');
  });
});
