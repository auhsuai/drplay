function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  // Same shape as the player bar's formatTime: drop the hours part when
  // the track is under an hour so "3:24" does not render as "00:03:24".
  if (h === 0) return `${String(m)}:${s.toString().padStart(2, "0")}`;
  return `${String(h)}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export { formatDuration };
