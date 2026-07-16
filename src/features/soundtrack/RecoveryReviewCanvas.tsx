import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, CheckCheck, ChevronRight, ExternalLink, FileVideo, MapPin, Music2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { clampTimelinePercent, normalizeMomentSelection, timeRangeStyle, type RuntimeSoundtrackMap, type TargetedRange } from "../../lib/soundtrack-map";
import { createCueSheet, createSoundtrackId, formatCueTimestamp, type SoundtrackEntry, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatTimeRange, formatTimestamp, pluralizeMoments } from "../workspace/utils";
import type { ActiveTrackPreview, EntryEdits, SourceVideo, TrackPreview } from "../workspace/types";
import { ScreenHeader } from "../scan/ScanCanvases";
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
  const mapDetail = mapUnavailable
    ? "This session has no retained local activity map. Checked moments and track evidence remain visible."
    : "Local activity and only the moments SonIQ actually checked. Activity is not a claim that a region is music.";

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
    <section className="soundtrack-map-surface" aria-labelledby="soundtrack-map-title">
      <div className="soundtrack-map-heading">
        <div>
          <h2 id="soundtrack-map-title">Soundtrack Map</h2>
          <p>{mapDetail}</p>
        </div>
        <span className="soundtrack-map-source" title={source.fileName}>
          <FileVideo size={13} aria-hidden="true" />
          {source.fileName}
        </span>
      </div>
      <div className="soundtrack-map-legend" aria-label="Map legend">
        <span><i className="soundtrack-map-key soundtrack-map-key--activity" aria-hidden="true" />Local activity</span>
        <span><i className="soundtrack-map-key soundtrack-map-key--checked" aria-hidden="true" />Checked</span>
        <span><i className="soundtrack-map-key soundtrack-map-key--evidence" aria-hidden="true" />Track evidence</span>
        <span><i className="soundtrack-map-key soundtrack-map-key--gap" aria-hidden="true" />Not checked</span>
      </div>
      {duration > 0 ? (
        <>
          <div className="soundtrack-map-lanes" aria-label="Source-relative soundtrack evidence">
            <div className="soundtrack-map-lane">
              <span className="soundtrack-map-lane-label">Activity</span>
              <div className="soundtrack-map-track" aria-label={mapUnavailable ? "No local activity map available" : "Local acoustic activity"}>
                {activityItems.length ? activityItems.map((item) => timelineRange(item)) : <span className="soundtrack-map-empty-lane">{mapUnavailable ? "Not retained" : "No distinct activity"}</span>}
              </div>
            </div>
            <div className="soundtrack-map-lane">
              <span className="soundtrack-map-lane-label">Checked</span>
              <div className="soundtrack-map-track" aria-label="Enhanced recognition coverage">
                {checkedItems.length ? checkedItems.map((item) => timelineRange(item)) : <span className="soundtrack-map-empty-lane">No enhanced checks</span>}
              </div>
            </div>
            <div className="soundtrack-map-lane">
              <span className="soundtrack-map-lane-label">Evidence</span>
              <div className="soundtrack-map-track" aria-label="Recovered track evidence">
                {evidenceItems.length ? evidenceItems.map((item) => timelineRange(item, true)) : <span className="soundtrack-map-empty-lane">No track evidence yet</span>}
              </div>
            </div>
            <div className="soundtrack-map-axis" aria-hidden="true"><span>00:00</span><span>{formatTimestamp(duration)}</span></div>
          </div>
          <ul className="soundtrack-map-timestamp-list" aria-label="Soundtrack map timestamp list">
            {actionItems.length ? actionItems.map((item) => {
              const selection = canInspect(item.range);
              const content = <><strong>{item.label}</strong><small>{formatTimeRange(item.range)} · {item.detail}</small></>;
              return (
                <li key={item.id}>
                  {selection ? <button type="button" onClick={() => onOpenMomentFinder(selection)}>{content}</button> : <span>{content}</span>}
                </li>
              );
            }) : <li><span><strong>No moment evidence yet</strong><small>Try a specific moment when a connected source is available.</small></span></li>}
          </ul>
        </>
      ) : (
        <p className="soundtrack-map-unavailable">SonIQ needs the source duration to place map evidence on a timeline.</p>
      )}
      <p className="soundtrack-map-hint">
        {sourceAvailable ? "Select an activity, checked range, or evidence marker to inspect it in Moment Finder. Nothing starts until you choose Try this moment." : "Reconnect the source video to inspect a moment. This saved view never invents local activity data."}
      </p>
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
      undoButtonRef.current?.focus();
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
    <section className="workspace-canvas review-canvas" aria-labelledby="screen-title">
      <div className="canvas-main">
        <ScreenHeader
          title="Recover this soundtrack"
          detail="Keep what is right, correct what is uncertain, or add what recognition missed. Only kept tracks appear in your cue sheet."
          preview={source.isFixture}
        />
        {!sourceAvailable && (
          <div className="review-toast" role="status">
            <span>This saved soundtrack has no connected source video. Its cue sheet and receipt remain available.</span>
            <button type="button" onClick={onReconnect}>Reconnect source</button>
          </div>
        )}
        {activeEntries.length > 0 && message && <p className="review-scan-note" role="status">{message}</p>}
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
          <div className="group-surface track-group">
            <div className="group-label-row">
              <span>{activeEntries.length + " " + (activeEntries.length === 1 ? "recovered track" : "recovered tracks")}{checkedSignatureCount ? " · " + checkedSignatureCount + " " + pluralizeMoments(checkedSignatureCount) + " checked" : ""}</span>
              <span title={source.fileName}><FileVideo size={13} aria-hidden="true" />{source.fileName}</span>
            </div>
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
              {sourceAvailable && <Button type="button" variant="secondary" onClick={() => onOpenMomentFinder()}><MapPin size={15} aria-hidden="true" />Try a moment</Button>}
              <Button type="button" variant="ghost" onClick={onNewScan}>Choose another video</Button>
            </div>
          </div>
        )}
        {removedId && removedEntries.some((entry) => entry.id === removedId) && (
          <div className="review-toast" role="status">
            <span>{removedEntries.find((entry) => entry.id === removedId)?.title ?? "Track"} is removed from the cue sheet.</span>
            <button ref={undoButtonRef} type="button" onClick={() => { onUndoRemove(removedId); setRemovedId(null); }}>Undo</button>
          </div>
        )}
        <div className="canvas-actions">
          <span className="quiet-note">{cueSheet.length ? "Your cue sheet includes only kept tracks." : "You can finish with an intentionally empty soundtrack."}</span>
          <div className="recovery-toolbar-actions">
            <Button type="button" variant="secondary" onClick={() => setShowManualForm(true)}><Plus size={15} aria-hidden="true" />Add track</Button>
            <Button type="button" variant="secondary" onClick={() => onOpenMomentFinder()} disabled={!sourceAvailable}><MapPin size={15} aria-hidden="true" />Find a moment</Button>
            <Button type="button" onClick={onContinue}>{cueSheet.length ? "Open cue sheet" : "Finish soundtrack"}<ChevronRight size={16} aria-hidden="true" /></Button>
          </div>
        </div>
      </div>
    </section>
  );
}

