import React, { useRef, useState } from 'react';
import ReactSelect from 'react-select';

import { Button, LineEdit, Selector, reactSelectStyles } from '../../ui/elements';
import { YoutubePlayerOwner } from '../../YoutubePlayer';
import { log } from '../../logger';
import './TrackInfo.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackData {
  id?: number;
  artist: string;
  track_name: string;
  length_seconds: number;
  bitrate_kbps?: number | null;
  tempo_bpm?: number | null;
  tags: string[];
  sources: string[];
}

export interface TrackInfoDialogProps {
  /** 'add' shows the Add button; 'edit' shows the Update button. */
  mode: 'add' | 'edit';
  /** Pre-populate the form when editing an existing track. */
  initialData?: Partial<TrackData>;
  /** Available tag options for the multi-select. */
  allTags?: string[];
  onAdd?:    (data: TrackData) => void;
  onUpdate?: (data: TrackData) => void;
  onClose:   () => void;
}

type Tab        = 'general' | 'sources';
type SourceType = 'youtube' | 'soundcloud' | 'local';
type TagOption  = { value: string; label: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYoutubeVideoId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TrackInfoDialog({
  mode,
  initialData = {},
  allTags = [],
  onAdd,
  onUpdate,
  onClose,
}: TrackInfoDialogProps) {
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // ── General tab state ──
  const [artist,      setArtist]      = useState(initialData.artist ?? '');
  const [trackName,   setTrackName]   = useState(initialData.track_name ?? '');
  const [lengthSec,   setLengthSec]   = useState(
    initialData.length_seconds != null ? String(initialData.length_seconds) : '',
  );
  const [bitrateKbps, setBitrateKbps] = useState(
    initialData.bitrate_kbps != null ? String(initialData.bitrate_kbps) : '',
  );
  const [tempoBpm,    setTempoBpm]    = useState(
    initialData.tempo_bpm != null ? String(initialData.tempo_bpm) : '',
  );
  const [selectedTags, setSelectedTags] = useState<TagOption[]>(
    (initialData.tags ?? []).map(t => ({ value: t, label: t })),
  );

  // ── Sources tab state ──
  const [sourceType,     setSourceType]     = useState<SourceType>('youtube');
  const [ytUrl,          setYtUrl]          = useState('');
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [scUrl,          setScUrl]          = useState('');
  const [localPath,      setLocalPath]      = useState('');
  // Ref to the preview player instance, populated via onPlayerReady.
  const previewPlayerRef = useRef<YT.Player | null>(null);
  const [previewPlayerReady, setPreviewPlayerReady] = useState(false);

  const tagOptions: TagOption[] = allTags.map(t => ({ value: t, label: t }));

  function buildData(): TrackData {
    return {
      id:             initialData.id,
      artist,
      track_name:     trackName,
      length_seconds: parseInt(lengthSec) || 0,
      bitrate_kbps:   bitrateKbps !== '' ? parseInt(bitrateKbps) : null,
      tempo_bpm:      tempoBpm    !== '' ? parseFloat(tempoBpm)  : null,
      tags:           selectedTags.map(t => t.value),
      sources: [
        ...(sourceType === 'youtube'    && ytUrl     ? [ytUrl]     : []),
        ...(sourceType === 'soundcloud' && scUrl     ? [scUrl]     : []),
        ...(sourceType === 'local'      && localPath ? [localPath] : []),
      ],
    };
  }

  const handleShowPreview = () => {
    previewPlayerRef.current = null; // reset on new load
    setPreviewPlayerReady(false);
    setPreviewVideoId(extractYoutubeVideoId(ytUrl));
  };

  const handleImportData = () => {
    const player = previewPlayerRef.current;
    if (!player) {
      log('[TrackInfo] Import Data: player not ready yet');
      return;
    }
    try {
      const videoData = player.getVideoData();
      const duration  = player.getDuration();
      const videoUrl  = player.getVideoUrl();

      // Log everything the API exposes so we know what's available.
      log('[TrackInfo] YouTube video data dump:');
      log(`  video_id   : ${videoData.video_id}`);
      log(`  title      : ${videoData.title}`);
      log(`  author     : ${videoData.author}`);
      log(`  duration   : ${duration}s`);
      log(`  video_url  : ${videoUrl}`);
      // getVideoData() may carry additional undocumented keys — log them too.
      for (const [k, v] of Object.entries(videoData)) {
        if (!['video_id', 'title', 'author'].includes(k)) {
          log(`  [extra] ${k}: ${v}`);
        }
      }

      // Populate general tab fields.
      // Titles often follow "Artist – Track" or "Artist - Track" patterns.
      const sep = videoData.title.match(/\s[–—-]\s/);
      if (sep) {
        const idx = videoData.title.indexOf(sep[0]);
        setArtist(videoData.title.slice(0, idx).trim());
        setTrackName(videoData.title.slice(idx + sep[0].length).trim());
      } else {
        // Fall back: put whole title in track name, channel as artist.
        setArtist(videoData.author ?? '');
        setTrackName(videoData.title ?? '');
      }

      if (duration > 0) {
        setLengthSec(String(Math.round(duration)));
      }
    } catch (e) {
      log(`[TrackInfo] Import Data failed: ${e}`);
    }
  };

  const handleSourceTypeChange = (v: string) => {
    setSourceType(v as SourceType);
    setPreviewVideoId(null);
  };

  return (
    <div className="ti-backdrop" onClick={onClose}>
      <div className="ti-dialog" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="ti-header">
          <span className="ti-title">{mode === 'add' ? 'Add Track' : 'Track Info'}</span>
        </div>

        {/* ── Tabs ── */}
        <div className="ti-tabs">
          <button
            className={`ti-tab${activeTab === 'general' ? ' ti-tab--active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`ti-tab${activeTab === 'sources' ? ' ti-tab--active' : ''}`}
            onClick={() => setActiveTab('sources')}
          >
            Sources
          </button>
        </div>

        {/* ── Tab content ── */}
        <div className="ti-content">

          {/* ── General tab ── */}
          <div className="ti-fields" style={{ display: activeTab === 'general' ? 'flex' : 'none' }}>
              <LineEdit
                label="Artist"
                placeholder="Artist name"
                value={artist}
                onChange={setArtist}
              />
              <LineEdit
                label="Track Name"
                placeholder="Track title"
                value={trackName}
                onChange={setTrackName}
              />
              <div className="ti-row">
                <LineEdit
                  label="Duration (s)"
                  placeholder="0"
                  type="number"
                  min={0}
                  value={lengthSec}
                  onChange={setLengthSec}
                />
                <LineEdit
                  label="Bitrate (kbps)"
                  placeholder="—"
                  type="number"
                  min={0}
                  value={bitrateKbps}
                  onChange={setBitrateKbps}
                />
                <LineEdit
                  label="Tempo (BPM)"
                  placeholder="—"
                  type="number"
                  min={0}
                  step={0.1}
                  value={tempoBpm}
                  onChange={setTempoBpm}
                />
              </div>
              <div className="ui-field">
                <label className="ui-label">Tags</label>
                <ReactSelect<TagOption, true>
                  isMulti
                  options={tagOptions}
                  value={selectedTags}
                  onChange={vals => setSelectedTags(vals as TagOption[])}
                  styles={reactSelectStyles<TagOption, true>()}
                  placeholder="Select tags…"
                  noOptionsMessage={() => 'No tags available'}
                />
              </div>
          </div>

          {/* ── Sources tab ── */}
          <div className="ti-fields" style={{ display: activeTab === 'sources' ? 'flex' : 'none' }}>
              <Selector
                label="Source Type"
                value={sourceType}
                options={[
                  { value: 'youtube',    label: 'YouTube'    },
                  { value: 'soundcloud', label: 'SoundCloud' },
                  { value: 'local',      label: 'Local File' },
                ]}
                onChange={handleSourceTypeChange}
              />

              {sourceType === 'youtube' && (
                <div className="ti-yt-section">
                  <div className="ti-yt-row">
                    <LineEdit
                      placeholder="https://www.youtube.com/watch?v=…"
                      value={ytUrl}
                      onChange={setYtUrl}
                    />
                    <Button variant="secondary" size="sm" onClick={handleShowPreview}>
                      Show
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!previewPlayerReady}
                      onClick={handleImportData}
                    >
                      Import Data
                    </Button>
                  </div>
                  {previewVideoId ? (
                    <div className="ti-yt-preview">
                      <YoutubePlayerOwner
                        videoId={previewVideoId}
                        onPlayerReady={p => { previewPlayerRef.current = p; setPreviewPlayerReady(true); }}
                      />
                    </div>
                  ) : (
                    <div className="ti-yt-placeholder">
                      Enter a YouTube URL and press Show to preview
                    </div>
                  )}
                </div>
              )}

              {sourceType === 'soundcloud' && (
                <LineEdit
                  label="SoundCloud URL"
                  placeholder="https://soundcloud.com/…"
                  value={scUrl}
                  onChange={setScUrl}
                />
              )}

              {sourceType === 'local' && (
                <LineEdit
                  label="Local File Path"
                  placeholder="/path/to/track.mp3"
                  value={localPath}
                  onChange={setLocalPath}
                />
              )}
          </div>
        </div>

        {/* ── Action buttons ── */}
        <div className="ti-actions">
          {mode === 'add'  && (
            <Button variant="primary" onClick={() => onAdd?.(buildData())}>Add</Button>
          )}
          {mode === 'edit' && (
            <Button variant="primary" onClick={() => onUpdate?.(buildData())}>Update</Button>
          )}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>

      </div>
    </div>
  );
}
