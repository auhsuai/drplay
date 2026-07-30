import { Track } from "../../App";
import { GripVertical, X, Music } from "lucide-react";

interface QueuePanelProps {
  isOpen: boolean;
  onClose: () => void;
  queue: Track[];
  currentTrack: Track | null;
  onPlayTrack: (track: Track) => void;
  onRemoveTrack: (trackId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function QueueItem({ track, isActive, onPlay, onRemove, index, onDragStart, onDragOver, onDrop }: {
  track: Track; isActive: boolean; onPlay: () => void; onRemove: () => void; index: number;
  onDragStart: (e: React.DragEvent, idx: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, idx: number) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 p-2 border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-[#2a2b2f] transition-colors group ${isActive ? "bg-blue-50 dark:bg-blue-900/20" : ""}`}
      onClick={onPlay}
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, index)}
    >
      <div className="text-gray-400 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity">
        <GripVertical className="w-4 h-4" />
      </div>
      <div className="w-8 h-8 bg-gray-200 dark:bg-[#121212] rounded flex items-center justify-center shrink-0">
        <Music className="w-4 h-4 text-gray-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${isActive ? "font-semibold text-[#4285F4]" : "text-gray-900 dark:text-gray-100"}`}>
          {track.title}
        </p>
        <p className="text-xs text-gray-500 truncate">{track.artist}</p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-gray-400 hover:text-red-500 transition-colors shrink-0 p-1 opacity-0 group-hover:opacity-100"
        title="Remove from queue"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function QueuePanel({ isOpen, onClose, queue, currentTrack, onPlayTrack, onRemoveTrack, onReorder }: QueuePanelProps) {
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex);
    }
  };

  return (
    <div className={`fixed right-0 top-0 h-full w-72 sm:w-80 bg-white dark:bg-[#202124] shadow-2xl z-50 transform transition-transform duration-300 ease-out ${isOpen ? "translate-x-0" : "translate-x-full"}`}>
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
          Queue <span className="text-gray-500 font-normal ml-1">({queue.length})</span>
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="overflow-y-auto h-[calc(100%-57px)]">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400 text-sm gap-2">
            <Music className="w-8 h-8" />
            <span>Queue is empty</span>
          </div>
        ) : (
          queue.map((track, index) => (
            <QueueItem
              key={track.queueItemId || track.id}
              track={track}
              index={index}
              isActive={currentTrack?.id === track.id}
              onPlay={() => onPlayTrack(track)}
              onRemove={() => onRemoveTrack(track.id)}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            />
          ))
        )}
      </div>
    </div>
  );
}
