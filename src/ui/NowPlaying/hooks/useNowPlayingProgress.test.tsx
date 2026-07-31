// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../../App';
import { formatTime } from '../../../utils/formatTime';
import { useNowPlayingProgress } from './useNowPlayingProgress';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: any) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    seek: vi.fn(),
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

vi.mock('../../../lib/AudioController', () => ({
  AudioController: { getInstance: () => fakeController },
}));

vi.mock('../../../lib/AudioController', () => ({
  AudioController: { getInstance: () => fakeController },
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    title: 'Song',
    artist: 'Artist',
    streamUrl: '/drive-stream/track-1',
    ...overrides,
  };
}

function Harness({ track, isOpen }: { track: Track | null; isOpen: boolean }) {
  const {
    duration,
    progressBarRef,
    progressFillRef,
    currentTimeTextRef,
    handlePointerDown,
  } = useNowPlayingProgress(track, isOpen);
  return (
    <div>
      <span ref={currentTimeTextRef} data-testid="time">0:00</span>
      <span data-testid="duration">{formatTime(duration)}</span>
      <div
        ref={progressBarRef}
        data-testid="bar"
        onPointerDown={handlePointerDown}
      >
        <div ref={progressFillRef} data-testid="fill" style={{ width: '0%' }}></div>
      </div>
    </div>
  );
}

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.seek.mockClear();
  fakeController.getDuration.mockClear();
  installFakeOn();
  fakeController.getDuration.mockReturnValue(0);
  fakeController._handlers = {};
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe('useNowPlayingProgress — progress sync driven by AudioController events', () => {
  it('BUG regression: updates progress fill + time text when AudioController emits timeupdate', () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId('time').textContent).toBe('0:00');

    act(() => {
      fakeController._emit('timeupdate', { currentTime: 60, duration: 240 });
    });

    expect(screen.getByTestId('time').textContent).toBe('1:00');
    expect(screen.getByTestId('fill').style.width).toBe('25%');
  });

  it('BUG regression: syncs duration state from AudioController durationchange event', () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId('duration').textContent).toBe('0:00');

    act(() => {
      fakeController._emit('durationchange', { duration: 240 });
    });

    expect(screen.getByTestId('duration').textContent).toBe('4:00');
  });

  it('seeds duration from AudioController.getDuration() on mount', () => {
    fakeController.getDuration.mockReturnValue(300);
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId('duration').textContent).toBe('5:00');
  });

  it('commits a drag via AudioController.seek (not a DOM audio element)', () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    act(() => {
      fakeController._emit('durationchange', { duration: 240 });
    });

    const bar = screen.getByTestId('bar');
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
  });

  it('unsubscribes both timeupdate and durationchange handlers on unmount (no listener leak)', () => {
    const { unmount } = render(<Harness track={makeTrack()} isOpen={true} />);
    expect(fakeController._handlers['timeupdate']).toHaveLength(1);
    expect(fakeController._handlers['durationchange']).toHaveLength(1);

    unmount();

    expect(fakeController._handlers['timeupdate'] ?? []).toHaveLength(0);
    expect(fakeController._handlers['durationchange'] ?? []).toHaveLength(0);
  });

  it('does not subscribe to realtime timeupdate when the view is closed', () => {
    render(<Harness track={makeTrack()} isOpen={false} />);
    expect(fakeController._handlers['timeupdate'] ?? []).toHaveLength(0);
  });
});
