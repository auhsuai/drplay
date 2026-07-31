// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
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
    'Repeat', 'Repeat1', 'Maximize2', 'RefreshCw',
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

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
    expect(seg.style.left).toBe('0%');
    expect(seg.style.width).toBe('30%');
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
    expect(seg.style.left).toBe('0%');
    expect(seg.style.width).toBe('30%');
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

  it('BUG regression: buffer bar shows multi-segment state for non-contiguous buffered ranges (forward seek)', () => {
    renderPlayer();
    const buffer = screen.getByTestId('buffer-fill');

    setBuffered([[0, 30], [500, 510]], 1000, 505);
    act(() => {
      fakeController._emit('progress');
    });

    expect(buffer.childElementCount).toBe(2);
    expect((buffer.children[0] as HTMLElement).style.left).toBe('0%');
    expect((buffer.children[1] as HTMLElement).style.left).toBe('50%');
    expect((buffer.children[1] as HTMLElement).style.width).toBe('1%');
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
