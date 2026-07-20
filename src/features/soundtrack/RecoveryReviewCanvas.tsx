import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Check, CheckCheck, ChevronRight, ExternalLink, FileVideo, MapPin, Music2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { clampTimelinePercent, normalizeMomentSelection, timeRangeStyle, type RuntimeSoundtrackMap, type TargetedRange } from "../../lib/soundtrack-map";
import { createCueSheet, createSoundtrackId, formatCueTimestamp, type SoundtrackEntry, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatTimeRange, formatTimestamp, pluralizeMoments } from "../workspace/utils";
import type { ActiveTrackPreview, EntryEdits, SourceVideo, TrackPreview } from "../workspace/types";
import { TrackArtwork } from "./TrackArtwork";

export function recoveryStateLabel(entry: SoundtrackEntry) {
  if (entry.state === "manual") return "Manual";
  if (entry.state === "edited") return "Edited";
  if (entry.state === "confirmed") return "Confirmed";
  if (entry.state === "removed") return "Removed";
  return "Suggested";
}

export function previewLookupKey(entry: Pick<SoundtrackEntry, "id" | "title" | "artist">) {
  return entry.id + "\u001f" + entry.title.trim() + "\u001f" + entry.artist.trim();
}

export function createManualEntry(draft: { title: string; artist: string; album: string; moment: string; note: string }): SoundtrackEntry {
  const createdAt = new Date().toISOString();
  const momentSeconds = Number(draft.moment);
  const hasMoment = Number.isFinite(momentSeconds) && momentSeconds >= 0;

  return {
    id: createSoundtrackId("manual-track"),
    state: "manual",
    selection: "kept",
    title: draft.title.trim(),
    artist: draft.artist.trim(),
    ...(draft.album.trim() ? { album: draft.album.trim() } : {}),
    ...(hasMoment ? { moment: { startSeconds: momentSeconds, precision: "user-assigned" as const } } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

type SoundtrackMapItem = {
  id: string;
  kind: "activity" | "checked" | "evidence";
  label: string;
  range: TargetedRange;
  detail: string;
};

/**
 * A deliberately small evidence surface, not a waveform editor or a promise
 * that every moment has been recognized. The activity map only lives for the
 * active local session; saved records keep their compact receipt/track evidence.
 */
export function SoundtrackMapSurface({
  source,
  record,
  map,
  sourceAvailable,
  onOpenMomentFinder,
}: {
  source: SourceVideo;
  record: SoundtrackRecord;
  map?: RuntimeSoundtrackMap;
  sourceAvailable: boolean;
  onOpenMomentFinder: (range?: TargetedRange) => void;
}) {
  const duration = source.durationSeconds ?? record.source.durationSeconds ?? 0;
  const checkedRanges = record.receipt.enhancedRecognition.signatureTransfer?.signatureRanges ?? [];
  const activityRegions = map?.available ? map.activityRegions : [];
  const evidenceMarkers = record.entries
    .filter((entry) => entry.state !== "removed")
    .flatMap((entry) => {
      const evidenceRanges = entry.evidence?.sampleRanges ?? [];
      if (evidenceRanges.length) {
        return evidenceRanges.map((range, index) => ({
          id: entry.id + "-evidence-" + index,
          label: entry.title,
          range,
        }));
      }
      return entry.moment ? [{
        id: entry.id + "-moment",
        label: entry.title,
        range: { startSeconds: entry.moment.startSeconds, endSeconds: entry.moment.startSeconds },
      }] : [];
    })
    .filter((marker) => Number.isFinite(marker.range.startSeconds))
    .slice(0, 12);
  const activityItems: SoundtrackMapItem[] = activityRegions.map((region, index) => ({
    id: "activity-" + index,
    kind: "activity",
    label: "Local activity",
    range: { startSeconds: region.startSeconds, endSeconds: region.endSeconds },
    detail: "Acoustic activity, not an identified track",
  }));
  const checkedItems: SoundtrackMapItem[] = checkedRanges.map((range, index) => ({
    id: "checked-" + index,
    kind: "checked",
    label: "Checked by enhanced recognition",
    range,
    detail: "An approved recognition signature was submitted",
  }));
  const evidenceItems: SoundtrackMapItem[] = evidenceMarkers.map((marker) => ({
    id: marker.id,
    kind: "evidence",
    label: marker.label,
    range: marker.range,
    detail: "Track evidence",
  }));
  const actionItems = [...activityItems, ...checkedItems, ...evidenceItems];
  const mapUnavailable = !map?.available;

  function canInspect(range: TargetedRange) {
    return sourceAvailable ? normalizeMomentSelection(range, duration) : null;
  }

  function inspectLabel(item: SoundtrackMapItem) {
    const range = formatTimeRange(item.range);
    return "Inspect " + item.label + " at " + range + " in Moment Finder";
  }

  function timelineRange(item: SoundtrackMapItem, marker = false) {
    const selection = canInspect(item.range);
    const style = marker
      ? { left: clampTimelinePercent(item.range.startSeconds, duration) + "%" }
      : timeRangeStyle(item.range, duration);
    const className = "soundtrack-map-segment soundtrack-map-segment--" + item.kind + (selection ? " is-actionable" : "");
    if (!selection) {
      return (
        <span key={item.id} className={className} style={style} title={item.label}>
          <span className="sr-only">{item.label + " at " + formatTimeRange(item.range) + ". " + item.detail}</span>
        </span>
      );
    }
    return (
      <button
        key={item.id}
        className={className}
        type="button"
        style={style}
        onClick={() => onOpenMomentFinder(selection)}
        aria-label={inspectLabel(item)}
        title={inspectLabel(item)}
      >
        <span className="sr-only">{inspectLabel(item)}</span>
      </button>
    );
  }

  return (
    <section className="timeline-scrubber-surface" aria-label="Soundtrack Map">
      {duration > 0 && (
        <>
          <div className="timeline-track-container" aria-label="Soundtrack evidence timeline">
            <div className="timeline-track">
              {activityItems.map((item) => timelineRange(item))}
              {checkedItems.map((item) => timelineRange(item))}
              {evidenceItems.map((item) => timelineRange(item, true))}
            </div>
            <div className="timeline-axis" aria-hidden="true"><span>00:00</span><span>{formatTimestamp(duration)}</span></div>
          </div>
        </>
      )}
    </section>
  );
}

export function RecoveryReviewCanvas({
  source,
  record,
  map,
  message,
  sourceAvailable,
  onToggleKept,
  onEdit,
  onRemove,
  onUndoRemove,
  onAddManual,
  onOpenMomentFinder,
  onReconnect,
  onContinue,
  onNewScan,
  isSpotifyConnected,
  spotifyAuthLoading,
  spotifyExportState,
  spotifyExportError,
  onSpotifyConnect,
  onSpotifyExport,
  exportPlatform,
  youtubeExportState,
  youtubeExportError,
  onYouTubeExport,
}: {
  source: SourceVideo;
  record: SoundtrackRecord;
  map?: RuntimeSoundtrackMap;
  message: string;
  sourceAvailable: boolean;
  onToggleKept: (entryId: string) => void;
  onEdit: (entryId: string, edits: EntryEdits) => void;
  onRemove: (entryId: string) => void;
  onUndoRemove: (entryId: string) => void;
  onAddManual: (entry: SoundtrackEntry) => void;
  onOpenMomentFinder: (range?: TargetedRange) => void;
  onReconnect: () => void;
  onContinue: () => void;
  onNewScan: () => void;
  isSpotifyConnected?: boolean;
  spotifyAuthLoading?: boolean;
  spotifyExportState?: "idle" | "loading" | "success" | "error";
  spotifyExportError?: string | null;
  onSpotifyConnect?: () => void;
  onSpotifyExport?: () => void;
  exportPlatform?: "spotify" | "youtube";
  youtubeExportState?: "idle" | "loading" | "success" | "error";
  youtubeExportError?: string | null;
  onYouTubeExport?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EntryEdits | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDraft, setManualDraft] = useState({ title: "", artist: "", album: "", moment: "", note: "" });
  const [manualError, setManualError] = useState("");
  const [removedId, setRemovedId] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<ActiveTrackPreview | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [unavailablePreviewKeys, setUnavailablePreviewKeys] = useState<Set<string>>(() => new Set());
  const [previewNotice, setPreviewNotice] = useState<{ entryId: string; message: string } | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewRequestRef = useRef(0);

  function disposePreviewAudio() {
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.onended = null;
    audio.onpause = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    previewAudioRef.current = null;
  }

  function markPreviewUnavailable(entry: SoundtrackEntry) {
    setUnavailablePreviewKeys((current) => {
      const next = new Set(current);
      next.add(previewLookupKey(entry));
      return next;
    });
    setPreviewNotice({ entryId: entry.id, message: "A streaming preview is not available for this track." });
  }

  async function toggleTrackPreview(entry: SoundtrackEntry) {
    const audio = previewAudioRef.current;
    if (activePreview?.entryId === entry.id && audio) {
      try {
        if (activePreview.playing) {
          audio.pause();
        } else {
          await audio.play();
          if (previewAudioRef.current === audio) {
            setActivePreview((current) => current?.entryId === entry.id ? { ...current, playing: true } : current);
          }
        }
      } catch {
        if (previewAudioRef.current === audio) {
          disposePreviewAudio();
          setActivePreview(null);
          markPreviewUnavailable(entry);
        }
      }
      return;
    }

    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    disposePreviewAudio();
    setActivePreview(null);
    setPreviewNotice({ entryId: entry.id, message: "Looking for a 30-second streaming preview…" });
    setPreviewLoadingId(entry.id);

    try {
      if (!isTauri()) throw new Error("Track previews are available in the SonIQ desktop app.");
      const preview = await invoke<TrackPreview>("lookup_track_preview", { title: entry.title, artist: entry.artist });
      if (previewRequestRef.current !== requestId) return;
      if (!preview.previewUrl || !preview.trackViewUrl) {
        markPreviewUnavailable(entry);
        return;
      }

      const nextAudio = new Audio();
      nextAudio.preload = "none";
      nextAudio.src = preview.previewUrl;
      nextAudio.onpause = () => {
        if (previewAudioRef.current === nextAudio && !nextAudio.ended) {
          setActivePreview((current) => current?.entryId === entry.id ? { ...current, playing: false } : current);
        }
      };
      nextAudio.onended = () => {
        if (previewAudioRef.current === nextAudio) {
          disposePreviewAudio();
          setActivePreview(null);
        }
      };
      nextAudio.onerror = () => {
        if (previewAudioRef.current === nextAudio) {
          disposePreviewAudio();
          setActivePreview(null);
          markPreviewUnavailable(entry);
        }
      };

      previewAudioRef.current = nextAudio;
      setActivePreview({ entryId: entry.id, preview, playing: false });
      setPreviewNotice(null);
      await nextAudio.play();
      if (previewAudioRef.current === nextAudio) {
        setActivePreview((current) => current?.entryId === entry.id ? { ...current, playing: true } : current);
      }
    } catch {
      if (previewRequestRef.current === requestId) {
        disposePreviewAudio();
        setActivePreview(null);
        markPreviewUnavailable(entry);
      }
    } finally {
      if (previewRequestRef.current === requestId) setPreviewLoadingId(null);
    }
  }

  async function openPreviewStore(preview: TrackPreview) {
    if (!preview.trackViewUrl) return;
    try {
      if (isTauri()) await openUrl(preview.trackViewUrl);
      else window.open(preview.trackViewUrl, "_blank", "noopener,noreferrer");
    } catch {
      setPreviewNotice({ entryId: activePreview?.entryId ?? "", message: "The iTunes Store link could not be opened." });
    }
  }

  const activeEntries = [...record.entries]
    .filter((entry) => entry.state !== "removed")
    .sort((left, right) => (left.moment?.startSeconds ?? Number.POSITIVE_INFINITY) - (right.moment?.startSeconds ?? Number.POSITIVE_INFINITY));
  const removedEntries = record.entries.filter((entry) => entry.state === "removed");
  const cueSheet = createCueSheet(record.entries);
  const checkedSignatureCount = record.receipt.enhancedRecognition.signatureTransfer?.signatureRanges?.length ?? 0;

  useEffect(() => {
    if (removedId && removedEntries.some((entry) => entry.id === removedId)) {
      undoButtonRef.current?.focus({ preventScroll: true });
    }
  }, [removedId, removedEntries]);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    disposePreviewAudio();
  }, []);

  function beginEditing(entry: SoundtrackEntry) {
    setEditingId(entry.id);
    setEditDraft({
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      note: entry.note,
      momentSeconds: entry.moment?.startSeconds ?? null,
    });
  }

  function saveEdit(entryId: string) {
    if (!editDraft || !editDraft.title.trim()) return;
    onEdit(entryId, {
      ...editDraft,
      title: editDraft.title.trim(),
      artist: editDraft.artist.trim(),
      album: editDraft.album?.trim(),
      note: editDraft.note?.trim(),
    });
    setEditingId(null);
    setEditDraft(null);
  }

  function submitManualTrack() {
    if (!manualDraft.title.trim()) {
      setManualError("Add a track title to continue.");
      return;
    }
    onAddManual(createManualEntry(manualDraft));
    setManualDraft({ title: "", artist: "", album: "", moment: "", note: "" });
    setManualError("");
    setShowManualForm(false);
  }

  function removeTrack(entry: SoundtrackEntry) {
    if (activePreview?.entryId === entry.id || previewLoadingId === entry.id) {
      previewRequestRef.current += 1;
      disposePreviewAudio();
      setActivePreview(null);
      setPreviewLoadingId(null);
      setPreviewNotice(null);
    }
    onRemove(entry.id);
    setRemovedId(entry.id);
  }

  return (
    <section className="workspace-canvas review-canvas" aria-label="Recovery Review">
      <div className="canvas-main-constrained">
        <div className="review-top-bar">
          <h1 className="review-title">{source.fileName}</h1>
          <span className="review-subtitle">{activeEntries.length} {activeEntries.length === 1 ? "track" : "tracks"} recognized</span>
        </div>
        <SoundtrackMapSurface source={source} record={record} map={map} sourceAvailable={sourceAvailable} onOpenMomentFinder={onOpenMomentFinder} />
        {showManualForm && (
          <form
            className="manual-track-panel"
            onSubmit={(event) => {
              event.preventDefault();
              submitManualTrack();
            }}
          >
            <label>
              Track title <input value={manualDraft.title} onChange={(event) => setManualDraft((draft) => ({ ...draft, title: event.target.value }))} autoFocus required aria-invalid={manualError ? true : undefined} aria-describedby={manualError ? "manual-track-error" : undefined} />
            </label>
            <label>
              Artist <input value={manualDraft.artist} onChange={(event) => setManualDraft((draft) => ({ ...draft, artist: event.target.value }))} placeholder="Optional" />
            </label>
            <label>
              Album <input value={manualDraft.album} onChange={(event) => setManualDraft((draft) => ({ ...draft, album: event.target.value }))} placeholder="Optional" />
            </label>
            <label>
              Moment <input type="number" min="0" step="1" value={manualDraft.moment} onChange={(event) => setManualDraft((draft) => ({ ...draft, moment: event.target.value }))} placeholder="Seconds, optional" />
            </label>
            <label className="field-span">
              Note <textarea value={manualDraft.note} onChange={(event) => setManualDraft((draft) => ({ ...draft, note: event.target.value }))} placeholder="Why this belongs here, optional" />
            </label>
            {manualError && <span id="manual-track-error" className="input-feedback field-span" role="alert"><span aria-hidden="true">!</span>{manualError}</span>}
            <div className="field-actions">
              <Button type="button" variant="ghost" onClick={() => { setShowManualForm(false); setManualError(""); }}>Cancel</Button>
              <Button type="submit"><Plus size={15} aria-hidden="true" />Add track</Button>
            </div>
          </form>
        )}
        {activeEntries.length > 0 ? (
          <div className="track-group edge-to-edge">
            <ul className="track-list" aria-label="Soundtrack entries">
              {activeEntries.map((entry, index) => {
                const isEditing = editingId === entry.id;
                const kept = entry.selection === "kept";
                const evidenceMoments = entry.evidence?.sampleRanges ?? [];
                const firstMoment = entry.moment?.startSeconds ?? evidenceMoments[0]?.startSeconds;
                const additionalMoments = Math.max(evidenceMoments.length - 1, 0);
                const previewKey = previewLookupKey(entry);
                const activePreviewForEntry = activePreview?.entryId === entry.id ? activePreview : null;
                const isPreviewLoading = previewLoadingId === entry.id;
                const canRequestPreview = Boolean(
                  entry.artist.trim() &&
                  entry.evidence &&
                  entry.evidence?.method !== "manual" &&
                  !unavailablePreviewKeys.has(previewKey),
                );
                const previewLabel = activePreviewForEntry?.playing
                  ? "Pause preview of " + entry.title + " by " + entry.artist
                  : isPreviewLoading
                    ? "Finding 30-second preview of " + entry.title + " by " + entry.artist
                    : "Play 30-second preview of " + entry.title + " by " + entry.artist;
                return (
                  <li key={entry.id}>
                    <div className={"track-row track-row--recovery" + (activePreviewForEntry ? " is-preview-active" : "")}>
                      <div className="track-row-main">
                        <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                        <TrackArtwork
                          candidate={entry}
                          preview={canRequestPreview ? {
                            loading: isPreviewLoading,
                            playing: Boolean(activePreviewForEntry?.playing),
                            label: previewLabel,
                            onToggle: () => { void toggleTrackPreview(entry); },
                          } : undefined}
                        />
                        <span className="track-copy">
                          <strong>{entry.title}</strong>
                          <small>{entry.artist || "Artist not added"}{firstMoment === undefined ? "" : " · " + formatCueTimestamp(firstMoment)}{additionalMoments ? " · " + (additionalMoments + 1) + " moments" : ""}</small>
                        </span>
                      </div>
                      <div className="track-row-meta">
                        <span className={"recovery-state is-" + entry.state}>{recoveryStateLabel(entry)}</span>
                        <div className="track-row-actions">
                          <Button type="button" variant={kept ? "secondary" : "primary"} onClick={() => onToggleKept(entry.id)} aria-pressed={kept}>
                            {kept ? <CheckCheck size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                            {kept ? "Kept" : "Keep"}
                          </Button>
                          <button className="quiet-action" type="button" onClick={() => beginEditing(entry)} aria-label={"Edit " + entry.title} title="Edit track">
                            <Pencil size={14} aria-hidden="true" />Edit
                          </button>
                          <button
                            className="quiet-action"
                            type="button"
                            onClick={() => removeTrack(entry)}
                            aria-label={"Remove " + entry.title}
                            title="Remove track"
                          >
                            <Trash2 size={14} aria-hidden="true" />Remove
                          </button>
                        </div>
                      </div>
                    </div>
                    {activePreviewForEntry && (
                      <div className="track-preview-disclosure">
                        <span>30-second preview · {activePreviewForEntry.preview.attribution}</span>
                        <button type="button" className="track-preview-store-link" onClick={() => { void openPreviewStore(activePreviewForEntry.preview); }}>
                          View in iTunes Store <ExternalLink size={12} aria-hidden="true" />
                        </button>
                        <small>Preview is a sample and does not confirm this recognition.</small>
                      </div>
                    )}
                    {previewNotice?.entryId === entry.id && (
                      <p className="track-preview-notice" role="status">{previewNotice.message}</p>
                    )}
                    {isEditing && editDraft && (
                      <form className="track-edit-panel" onSubmit={(event) => { event.preventDefault(); saveEdit(entry.id); }}>
                        <label>
                          Title <input value={editDraft.title} onChange={(event) => setEditDraft((draft) => draft ? { ...draft, title: event.target.value } : draft)} autoFocus required />
                        </label>
                        <label>
                          Artist <input value={editDraft.artist} onChange={(event) => setEditDraft((draft) => draft ? { ...draft, artist: event.target.value } : draft)} />
                        </label>
                        <label>
                          Album <input value={editDraft.album ?? ""} onChange={(event) => setEditDraft((draft) => draft ? { ...draft, album: event.target.value } : draft)} placeholder="Optional" />
                        </label>
                        <label>
                          Moment <input type="number" min="0" step="1" value={editDraft.momentSeconds ?? ""} onChange={(event) => setEditDraft((draft) => draft ? { ...draft, momentSeconds: event.target.value === "" ? null : Number(event.target.value) } : draft)} />
                        </label>
                        <label className="field-span">
                          Note <textarea value={editDraft.note ?? ""} onChange={(event) => setEditDraft((draft) => draft ? { ...draft, note: event.target.value } : draft)} placeholder="Optional correction note" />
                        </label>
                        <div className="field-actions">
                          <Button type="button" variant="ghost" onClick={() => { setEditingId(null); setEditDraft(null); }}>Cancel</Button>
                          <Button type="submit">Save correction</Button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="empty-review-state">
            <span className="library-icon" aria-hidden="true"><Music2 size={23} strokeWidth={1.55} /></span>
            <h2>No tracks to review yet</h2>
            <p>{message}</p>
            <div className="review-empty-actions">
              <Button type="button" onClick={() => setShowManualForm(true)}><Plus size={15} aria-hidden="true" />Add a track manually</Button>
              {sourceAvailable ? (
                <Button type="button" variant="secondary" onClick={() => onOpenMomentFinder()}><MapPin size={15} aria-hidden="true" />Try a moment</Button>
              ) : (
                <Button type="button" variant="secondary" onClick={onReconnect}><MapPin size={15} aria-hidden="true" />Reconnect video</Button>
              )}
              <Button type="button" variant="ghost" onClick={onNewScan}>Choose another video</Button>
            </div>
          </div>
        )}
        {removedId && removedEntries.some((entry) => entry.id === removedId) && (
          <div className="review-toast review-toast--inline" role="status">
            <span>{removedEntries.find((entry) => entry.id === removedId)?.title ?? "Track"} is removed from the playlist.</span>
            <button ref={undoButtonRef} type="button" onClick={() => { onUndoRemove(removedId); setRemovedId(null); }}>Undo</button>
          </div>
        )}
      <div className="canvas-actions">
        <span className="quiet-note">{cueSheet.length ? "Your playlist includes only kept tracks." : "You can finish with an intentionally empty playlist."}</span>
        <Button type="button" onClick={onContinue}>{cueSheet.length ? "Save Playlist" : "Finish"}<ChevronRight size={16} aria-hidden="true" /></Button>
      </div>
      </div>
    </section>
  );
}

