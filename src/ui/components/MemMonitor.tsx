import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Snapshot {
  process_working_set_mb: number;
  slice_cache_entries: number;
  slice_cache_bytes: number;
  slice_cache_mb: number;
  slice_cache_track_count: number;
  ts: number;
}

interface Sample {
  t: string;
  procMb: number;
  cacheMb: number;
  webMb: number;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function MemMonitor() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [open, setOpen] = useState(true);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const s = (await invoke('get_memory_snapshot')) as Snapshot;
        setSnap(s);
        const webMb =
          (performance as any).memory?.usedJSHeapSize
            ? Math.round((performance as any).memory.usedJSHeapSize / (1024 * 1024))
            : 0;
        const now = new Date();
        const label = `${now.getHours().toString().padStart(2, '0')}:${now
          .getMinutes()
          .toString()
          .padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        setHistory((h) => [...h.slice(-11), { t: label, procMb: s.process_working_set_mb, cacheMb: s.slice_cache_mb, webMb }]);
      } catch (e) {
        // ignore
      }
    };
    tick();
    timer.current = window.setInterval(tick, 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={btn}
        title="Mở RAM monitor"
      >
        RAM
      </button>
    );
  }

  const maxMb = Math.max(1, ...history.map((h) => h.procMb + h.cacheMb + h.webMb));

  return (
    <div style={panel}>
      <div style={head}>
        <span>RAM Monitor (dev)</span>
        <button onClick={() => setOpen(false)} style={xbtn}>
          ×
        </button>
      </div>

      {snap && (
        <div style={row}>
          <span>Process (Rust):</span>
          <b>{fmtMb(snap.process_working_set_mb)}</b>
        </div>
      )}
      {snap && (
        <div style={row}>
          <span>SliceCache:</span>
          <b>
            {fmtMb(snap.slice_cache_mb)} ({snap.slice_cache_entries} slices / {snap.slice_cache_track_count} tracks)
          </b>
        </div>
      )}
      <div style={row}>
        <span>WebView (JS heap):</span>
        <b>{history.length ? fmtMb(history[history.length - 1].webMb) : '—'}</b>
      </div>

      <div style={chart}>
        {history.map((h, i) => {
          const total = h.procMb + h.cacheMb + h.webMb;
          const pct = (total / maxMb) * 100;
          return (
            <div key={i} style={barWrap} title={`${h.t}  proc=${h.procMb} cache=${h.cacheMb} web=${h.webMb}`}>
              <div style={{ ...bar, height: `${pct}%` }} />
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, opacity: 0.6 }}>mỗi gạch = 1s (proc+cache+web)</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  position: 'fixed',
  right: 8,
  bottom: 8,
  zIndex: 10002,
  background: '#222',
  color: '#0f0',
  border: '1px solid #0f0',
  borderRadius: 6,
  padding: '4px 8px',
  fontFamily: 'monospace',
  cursor: 'pointer',
};

const panel: React.CSSProperties = {
  position: 'fixed',
  right: 8,
  bottom: 8,
  zIndex: 10002,
  width: 260,
  background: 'rgba(10,10,10,0.92)',
  color: '#0f0',
  border: '1px solid #0f0',
  borderRadius: 8,
  padding: 8,
  fontFamily: 'monospace',
  fontSize: 12,
};

const head: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 6,
  borderBottom: '1px solid #0a0',
  paddingBottom: 4,
};

const xbtn: React.CSSProperties = {
  background: 'transparent',
  color: '#0f0',
  border: 'none',
  fontSize: 16,
  cursor: 'pointer',
  lineHeight: 1,
};

const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  margin: '2px 0',
};

const chart: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 2,
  height: 60,
  marginTop: 6,
  borderTop: '1px solid #0a0',
  paddingTop: 4,
};

const barWrap: React.CSSProperties = {
  flex: 1,
  height: '100%',
  display: 'flex',
  alignItems: 'flex-end',
  background: '#030',
  borderRadius: 2,
};

const bar: React.CSSProperties = {
  width: '100%',
  background: '#0f0',
  borderRadius: 2,
};
