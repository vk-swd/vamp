import React from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TrackWithSources } from '../db/data/TrackItem';
import { TrackItem } from '../db/data/TrackItem';
import '../db/data/TrackList.css';
import { Button } from '../ui/elements';
import { usePlayerStore } from '../store';

// ─── SortableTrackItem ────────────────────────────────────────────────────────

interface SortableTrackItemProps {
  track: TrackWithSources;
  onRemove: (trackId: number) => void;
}

function SortableTrackItem({ track, onRemove }: SortableTrackItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`playlist-item${isDragging ? ' playlist-item--dragging' : ''}`}
    >
      <span className="playlist-item__drag-handle" {...attributes} {...listeners}>⠿</span>
      <TrackItem
        track={track}
        selectionMode={false}
        selected={false}
        activeSource={track.sources[0]?.url ?? null}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onSourceChange={() => {}}
      />
      <Button
        size="sm"
        onClick={() => onRemove(track.id)}
      >✕</Button>
    </div>
  );
}

// ─── DragOverlay item (ghost) ─────────────────────────────────────────────────

function DragOverlayItem({ track }: { track: TrackWithSources }) {
  return (
    <div className="playlist-sortable-row playlist-sortable-row--overlay">
      <span className="playlist-item__drag-handle">⠿</span>
      <TrackItem
        track={track}
        selectionMode={false}
        selected={false}
        activeSource={track.sources[0]?.url ?? null}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onSourceChange={() => {}}
      />
    </div>
  );
}

// ─── PlaylistView ─────────────────────────────────────────────────────────────

export interface PlaylistViewProps {
  tracks: TrackWithSources[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (trackId: number) => void;
}

export function PlaylistView({ tracks, onReorder, onRemove }: PlaylistViewProps) {
  const [activeId, setActiveId] = React.useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  }));

  const activeTrack = activeId !== null ? tracks.find(t => t.id === activeId) ?? null : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = tracks.findIndex(t => t.id === active.id);
    const toIndex = tracks.findIndex(t => t.id === over.id);
    if (fromIndex !== -1 && toIndex !== -1) {
      onReorder(fromIndex, toIndex);
    }
  }

  if (tracks.length === 0) {
    return (
      <div className="playlist-view">
        <p className="playlist-view__empty">No tracks yet. Right-click a track in the library to add it.</p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={tracks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div className="playlist-view">
            {tracks.map(track => (
              <SortableTrackItem key={track.id} track={track} onRemove={onRemove} />
            ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeTrack && <DragOverlayItem track={activeTrack} />}
      </DragOverlay>
    </DndContext>
  );
}
