import { useEffect, useRef, useState } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { ChevronRight, FileVideo, Pause, Play } from "lucide-react";
import { Button } from "../../components/ui/button";
import { normalizeMomentSelection, type TargetedRange } from "../../lib/soundtrack-map";
import { formatCueTimestamp, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatRangeList, plannedEnhancedTargetedRanges, pluralizeMoments } from "../workspace/utils";
import type { SourceVideo, WaveformEnvelope } from "../workspace/types";
import { ScreenHeader } from "../scan/ScanCanvases";
import { recoveryStateLabel } from "../soundtrack/RecoveryReviewCanvas";

export function MomentFinderCanvas({
  source,
  record,
  waveform,
  waveformLoading,
  enhancedRecognition,
  initialRange,
  onEnhancedRecognitionChange,
  onStartTargetedRecovery,
  onCancelRecovery,
  notice,
  onBack,
}: {
  source: SourceVideo;
  record: SoundtrackRecord;
  waveform: WaveformEnvelope | null;
  waveformLoading: boolean;
  enhancedRecognition: boolean;
  initialRange?: TargetedRange | null;
  onEnhancedRecognitionChange: (enabled: boolean) => void;
  onStartTargetedRecovery: (range: TargetedRange) => Promise<void>;
  onCancelRecovery: () => void;
  notice: string;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const duration = source.durationSeconds ?? record.source.durationSeconds ?? 0;
  const defaultWindow = Math.min(8, Math.max(duration, 0));
  const [playhead, setPlayhead] = useState(0);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(defaultWindow);
  const [selectionMode, setSelectionMode] = useState<"follows-playhead" | "custom">("follows-playhead");
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const sourceUrl = source.path && isTauri() ? convertFileSrc(source.path) : undefined;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const interactiveTarget = target?.closest("input, textarea, select, button, summary, video, a, [contenteditable='true'], [role='button'], [role='slider']");
      if (event.defaultPrevented || interactiveTarget) return;
      if (event.key === " " && sourceUrl && !previewUnavailable) {
        event.preventDefault();
        void togglePlayback();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewUnavailable, sourceUrl]);

  useEffect(() => {
    const initialMoment = record.entries.find((entry) => entry.moment)?.moment?.startSeconds ?? 0;
    const mappedSelection = initialRange ? normalizeMomentSelection(initialRange, duration) : null;
    const boundedStart = mappedSelection
      ? mappedSelection.startSeconds
      : Math.min(Math.max(initialMoment, 0), Math.max(duration - defaultWindow, 0));
    setPlayhead(boundedStart);
    setRangeStart(boundedStart);
    setRangeEnd(mappedSelection?.endSeconds ?? Math.min(duration, boundedStart + defaultWindow));
    setSelectionMode(mappedSelection ? "custom" : "follows-playhead");
    if (videoRef.current) videoRef.current.currentTime = boundedStart;
    setPreviewUnavailable(false);
    setConfirming(false);
  }, [record.id, duration, defaultWindow, initialRange?.startSeconds, initialRange?.endSeconds]);

  const selectedRange = { startSeconds: Math.min(rangeStart, rangeEnd), endSeconds: Math.max(rangeStart, rangeEnd) };
  const rangeLength = Math.max(0, selectedRange.endSeconds - selectedRange.startSeconds);
  const rangeIsValid = rangeLength >= 8 && rangeLength <= 28;
  const enhancedTargetRanges = plannedEnhancedTargetedRanges(selectedRange);
  const enhancedCheckCount = enhancedTargetRanges.length;
  const primaryRecoveryLabel = enhancedRecognition && enhancedCheckCount > 1
    ? "Scan " + enhancedCheckCount + " moments"
    : "Search this moment";
  const bars = waveform?.amplitudes?.length ? waveform.amplitudes : Array.from({ length: 56 }, (_, index) => 0.12 + ((index * 13) % 7) / 16);
  const markers = record.entries.filter((entry) => entry.state !== "removed" && entry.moment);

  function applyPlayheadTarget(nextSeconds: number) {
    const start = Math.min(Math.max(nextSeconds, 0), Math.max(duration - defaultWindow, 0));
    setRangeStart(start);
    setRangeEnd(Math.min(duration, start + defaultWindow));
  }

  function seek(nextSeconds: number, moveTarget = selectionMode === "follows-playhead") {
    const next = Math.min(Math.max(nextSeconds, 0), duration || 0);
    setPlayhead(next);
    if (videoRef.current) videoRef.current.currentTime = next;
    if (moveTarget) {
      setSelectionMode("follows-playhead");
      applyPlayheadTarget(next);
    }
  }

  function setCustomStart() {
    const next = Math.min(playhead, Math.max(duration - 8, 0));
    setSelectionMode("custom");
    setRangeStart(next);
    if (rangeEnd <= next || rangeEnd - next > 28) setRangeEnd(Math.min(duration, next + defaultWindow));
  }

  function setCustomEnd() {
    const next = Math.min(Math.max(playhead, rangeStart + 8), Math.min(duration, rangeStart + 28));
    setSelectionMode("custom");
    setRangeEnd(next);
  }

  function usePlayheadTarget() {
    setSelectionMode("follows-playhead");
    applyPlayheadTarget(playhead);
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
        setIsPlaying(true);
      } catch {
        setPreviewUnavailable(true);
      }
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }

  async function startTargetedRecovery() {
    if (!rangeIsValid) return;
    setIsRecovering(true);
    try {
      await onStartTargetedRecovery(selectedRange);
    } finally {
      setIsRecovering(false);
    }
  }

  return (
    <section className="workspace-canvas moment-canvas" aria-labelledby="screen-title">
      <div className="canvas-main">
        <ScreenHeader
          title="Find a soundtrack moment"
          detail="Scrub to a moment to place an eight-second check, or set a custom 8–28 second range to sweep a small transition."
          preview={source.isFixture}
        />
        <div className="group-surface">
          <div className="moment-layout">
            <div className="moment-media">
              <div className="moment-preview">
                {sourceUrl && !previewUnavailable ? (
                  <video
                    ref={videoRef}
                    src={sourceUrl}
                    controls
                    preload="metadata"
                    onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)}
                    onSeeked={(event) => {
                      const next = event.currentTarget.currentTime;
                      setPlayhead(next);
                      if (event.currentTarget.paused && selectionMode === "follows-playhead") applyPlayheadTarget(next);
                    }}
                    onPause={(event) => {
                      const next = event.currentTarget.currentTime;
                      setIsPlaying(false);
                      setPlayhead(next);
                      if (selectionMode === "follows-playhead") applyPlayheadTarget(next);
                    }}
                    onEnded={() => setIsPlaying(false)}
                    onError={() => setPreviewUnavailable(true)}
                    aria-label={"Local preview of " + source.fileName}
                  />
                ) : (
                  <div className="moment-preview-fallback">
                    <div>
                      <FileVideo size={24} aria-hidden="true" />
                      <p>The video preview is unavailable here. You can still use timestamps, correct tracks, and export the soundtrack.</p>
                      <p className="moment-fallback-timestamp"><strong>Current time</strong>{formatCueTimestamp(playhead) + " · selected " + formatCueTimestamp(selectedRange.startSeconds) + "–" + formatCueTimestamp(selectedRange.endSeconds)}</p>
                    </div>
                  </div>
                )}
              </div>
              <div className="moment-timeline">
                <div className="moment-time-row">
                  <strong>{formatCueTimestamp(playhead)}</strong>
                  <span>{source.duration ?? record.source.durationLabel ?? formatCueTimestamp(duration)}</span>
                </div>
                <div className="moment-track">
                  <div className="waveform-bars" aria-hidden="true">
                    {bars.map((amplitude, index) => <span className="waveform-bar" style={{ height: Math.max(10, Math.min(100, amplitude * 100)) + "%" }} key={index} />)}
                  </div>
                  {duration > 0 && (
                    <span
                      className="timeline-range-fill"
                      style={{ left: (selectedRange.startSeconds / duration) * 100 + "%", width: (rangeLength / duration) * 100 + "%" }}
                      aria-hidden="true"
                    />
                  )}
                  {duration > 0 && <span className="timeline-playhead" style={{ left: (playhead / duration) * 100 + "%" }} aria-hidden="true" />}
                  {duration > 0 && markers.map((entry) => {
                    const moment = entry.moment?.startSeconds ?? 0;
                    return (
                      <button
                        className={"timeline-marker is-" + entry.state}
                        style={{ left: Math.min(100, (moment / duration) * 100) + "%" }}
                        type="button"
                        key={entry.id}
                        onClick={() => seek(moment, true)}
                        aria-label={recoveryStateLabel(entry) + " marker for " + entry.title + " at " + formatCueTimestamp(moment)}
                        title={entry.title + " · " + formatCueTimestamp(moment)}
                      />
                    );
                  })}
                  <input
                    className="timeline-scrubber"
                    aria-label="Source video playhead"
                    aria-valuetext={formatCueTimestamp(playhead) + " of " + formatCueTimestamp(duration)}
                    type="range"
                    min="0"
                    max={Math.max(duration, 0)}
                    step="0.1"
                    value={Math.min(playhead, duration)}
                    onChange={(event) => seek(Number(event.target.value))}
                    disabled={!duration}
                  />
                  <span className="sr-only" aria-live="polite">{"Playhead " + formatCueTimestamp(playhead) + " of " + formatCueTimestamp(duration)}</span>
                </div>
                <div className="timeline-scale"><span>00:00</span><span>{formatCueTimestamp(duration)}</span></div>
              </div>
            </div>
            <aside className="moment-inspector" aria-label="Moment recovery controls">
              <div className="moment-inspector-heading">
                <h2>Selected moment</h2>
                <p>{waveformLoading ? "Preparing a local amplitude envelope…" : "Scrubbing places the default target. Markers show saved evidence, not complete recognition."}</p>
              </div>
              <div className="moment-inspector-body">
                <div className="moment-control-row">
                  <span>{selectionMode === "follows-playhead" ? "Target follows your last scrub" : "Custom target range"}</span>
                  <div className="range-summary"><strong>{formatCueTimestamp(selectedRange.startSeconds) + "–" + formatCueTimestamp(selectedRange.endSeconds)}</strong><small>{enhancedRecognition ? enhancedCheckCount + " short " + pluralizeMoments(enhancedCheckCount) : Math.round(rangeLength) + " seconds"}</small></div>
                  <div className="range-controls">
                    <button className={selectionMode === "follows-playhead" ? "quiet-action is-selected" : "quiet-action"} type="button" onClick={usePlayheadTarget}>Use playhead</button>
                    <button className="quiet-action" type="button" onClick={setCustomStart}>Set custom start</button>
                    <button className="quiet-action" type="button" onClick={setCustomEnd}>Set custom end</button>
                  </div>
                  {enhancedRecognition && enhancedTargetRanges.length > 0 && <small className="range-disclosure">Will check {formatRangeList(enhancedTargetRanges)}.</small>}
                </div>
                <div className="moment-control-row">
                  <span>Playback</span>
                  <div className="inline-actions">
                    <Button type="button" variant="secondary" onClick={togglePlayback} disabled={!sourceUrl || previewUnavailable}>{isPlaying ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{isPlaying ? "Pause" : "Play"}</Button>
                    <button className="quiet-action" type="button" onClick={() => seek(selectedRange.startSeconds)}>Jump to start</button>
                  </div>
                </div>
                {markers.length > 0 && <ul className="moment-evidence-list" aria-label="Saved evidence">
                  {markers.map((entry) => <li key={entry.id}><button type="button" onClick={() => seek(entry.moment?.startSeconds ?? 0, true)}>{formatCueTimestamp(entry.moment?.startSeconds)}</button><span><strong>{entry.title}</strong><small>{recoveryStateLabel(entry) + " · " + (entry.evidence?.confidence ?? "Local evidence")}</small></span></li>)}
                </ul>}
              </div>
            </aside>
          </div>
        </div>
        {confirming && (
          <div className="targeted-confirmation" aria-live="polite">
            <div className="targeted-confirmation-copy">
              <strong>Confirm this moment recovery</strong>
              <span>SonIQ will process only {formatCueTimestamp(selectedRange.startSeconds) + "–" + formatCueTimestamp(selectedRange.endSeconds)} locally. {enhancedRecognition ? "It will create " + enhancedCheckCount + " short recognition " + (enhancedCheckCount === 1 ? "signature" : "signatures") + " for " + formatRangeList(enhancedTargetRanges) + ", then use the experimental, unofficial endpoint." : "Enhanced recognition is off; only standard local fingerprint matching will run."} {!rangeIsValid && " Choose a range from 8 to 28 seconds to continue."}</span>
              <label className="enhanced-recognition-choice">
                <input type="checkbox" checked={enhancedRecognition} onChange={(event) => onEnhancedRecognitionChange(event.target.checked)} />
                <span><strong>Enhanced recognition <em>Experimental</em></strong><small>Optional signature lookup. Your source video and raw PCM stay on this Mac.</small></span>
              </label>
            </div>
            <div className="targeted-confirmation-actions">
              <Button type="button" variant="ghost" onClick={() => isRecovering ? onCancelRecovery() : setConfirming(false)}>{isRecovering ? "Cancel recovery" : "Cancel"}</Button>
              <Button type="button" onClick={startTargetedRecovery} disabled={isRecovering || !rangeIsValid}>{isRecovering ? "Recovering…" : primaryRecoveryLabel}<ChevronRight size={16} aria-hidden="true" /></Button>
            </div>
          </div>
        )}
        {notice && <p className="input-feedback" role="alert"><span aria-hidden="true">!</span>{notice}</p>}
        <div className="canvas-actions">
          <span className="quiet-note">{sourceUrl && !previewUnavailable ? "Preview, scrubber, and waveform data remain local to this session." : "The timestamp list remains available without local preview playback."}</span>
          <Button type="button" variant="secondary" onClick={onBack}>Back to soundtrack</Button>
          <Button type="button" onClick={() => setConfirming(true)} disabled={!source.path || !rangeIsValid || waveformLoading}>{primaryRecoveryLabel}<ChevronRight size={16} aria-hidden="true" /></Button>
        </div>
      </div>
    </section>
  );
}

