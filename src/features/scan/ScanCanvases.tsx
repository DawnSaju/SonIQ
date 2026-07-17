import type { DragEvent } from "react";
import { Check, ChevronRight, FileVideo, LockKeyhole } from "lucide-react";
import { Button } from "../../components/ui/button";
import { developmentFixture } from "../../lib/fixture";
import { maxEnhancedDiscoverySignatures, plannedLocalSampleCount } from "../workspace/utils";
import type { ScanProgress, SourceVideo } from "../workspace/types";

export function ScreenHeader({ title, detail, preview }: { title: string; detail: string; preview?: boolean }) {
  return (
    <header className="screen-header">
      <div>
        <h1 id="screen-title" tabIndex={-1}>{title}</h1>
        <p>{detail}</p>
      </div>
      {preview && <span className="preview-tag">Preview data</span>}
    </header>
  );
}

export function SourceRow({ source }: { source: SourceVideo }) {
  return (
    <div className="source-row">
      <span className="source-icon" aria-hidden="true">
        <FileVideo size={18} strokeWidth={1.7} />
      </span>
      <span className="source-name">
        <strong>{source.fileName}</strong>
        <small>
          {source.duration} <b aria-hidden="true">·</b> Source video
        </small>
      </span>
      <span className="source-state">
        <Check size={13} aria-hidden="true" />
        Ready
      </span>
    </div>
  );
}



export function IntakeCanvas({
  displayName,
  onSelect,
  onDrop,
  dragActive,
  onDragChange,
  validationMessage,
}: {
  displayName: string;
  onSelect: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  dragActive: boolean;
  onDragChange: (active: boolean) => void;
  validationMessage: string;
}) {
  const detail = displayName.trim()
    ? "You are all set, " + displayName.trim() + ". Select a local source video to begin a soundtrack scan."
    : "Select a local source video to begin a soundtrack scan.";

  return (
    <section
      className={dragActive ? "full-bleed-dropzone is-dragging" : "full-bleed-dropzone"}
      aria-labelledby="screen-title"
      onDragEnter={(event) => {
        event.preventDefault();
        onDragChange(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) onDragChange(false);
      }}
      onDrop={onDrop}
    >
      <div className="dropzone-content">
        <span className="source-drop-icon" aria-hidden="true">
          <FileVideo size={42} strokeWidth={1.2} />
        </span>
        <h1 id="screen-title" className="dropzone-title" tabIndex={-1}>Choose a video</h1>
        <p className="dropzone-detail">{detail}</p>

        <div className="dropzone-actions">
          <Button type="button" onClick={onSelect} variant="primary" size="default">
            Choose a video
          </Button>
          <span className="supported-formats">Supports MP4, MOV, and M4V</span>
        </div>

        {validationMessage && (
          <p className="input-feedback dropzone-error" role="alert">
            <span aria-hidden="true">!</span>
            {validationMessage}
          </p>
        )}
      </div>

      <footer className="canvas-footnote full-bleed-footnote">
        <LockKeyhole size={16} aria-hidden="true" />
        <span>Your video remains on this Mac. SonIQ creates fingerprints locally</span>
      </footer>
    </section>
  );
}

export function PendingCanvas({
  source,
  notice,
  enhancedRecognition,
  onBack,
  onEnhancedRecognitionChange,
  onStart,
}: {
  source: SourceVideo;
  notice: string;
  enhancedRecognition: boolean;
  onBack: () => void;
  onEnhancedRecognitionChange: (enabled: boolean) => void;
  onStart: () => void;
}) {
  return (
    <section className="workspace-canvas state-canvas" aria-labelledby="screen-title">
      <div className="canvas-main canvas-main--centered">
        <ScreenHeader
          title="Ready to scan"
          detail="Your original file never leaves this Mac."
          preview={source.isFixture}
        />
        
        <div className="group-surface">
          <SourceRow source={source} />
          <label className={source.isFixture ? "enhanced-recognition-choice is-disabled" : "enhanced-recognition-choice"}>
            <input
              type="checkbox"
              checked={source.isFixture ? false : enhancedRecognition}
              disabled={source.isFixture}
              onChange={(event) => onEnhancedRecognitionChange(event.target.checked)}
            />
            <span>
              <strong>Enhanced recognition</strong>
              <small>Identifies tracks using short audio signatures. Turn this off for local fingerprint-only recognition.</small>
            </span>
          </label>
        </div>
        {notice && (
          <p className="input-feedback" role="alert">
            <span aria-hidden="true">!</span>
            {notice}
          </p>
        )}
        <div className="canvas-actions">
          <Button variant="ghost" type="button" onClick={onBack}>
            Choose another
          </Button>
          <Button type="button" onClick={onStart}>
            Start scan
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ScanningCanvas({
  source,
  progress,
  enhancedRecognition,
  onCancel,
  onNext,
}: {
  source: SourceVideo;
  progress: ScanProgress | null;
  enhancedRecognition: boolean;
  onCancel?: () => void;
  onNext?: () => void;
}) {
  const isPreview = source.isFixture;
  const localSampleCount = isPreview ? developmentFixture.samples.length : plannedLocalSampleCount(source);
  const plannedSteps = isPreview
    ? developmentFixture.samples.map((timestamp, index) => ({ kind: "local" as const, label: "Local audio sample", detail: "Captured at " + timestamp, index }))
    : [];
  const totalSteps = Math.max(progress?.totalSamples ?? localSampleCount, 1);
  const completedSteps = Math.min(progress?.completedSamples ?? 0, totalSteps);

  return (
    <section className="workspace-canvas state-canvas" aria-labelledby="screen-title">
      <div className="canvas-main">
        <ScreenHeader
          title={isPreview ? "Scan preview" : "Scanning locally"}
          detail={isPreview ? "This development preview shows the three local sample windows that feed recognition." : "SonIQ maps local activity, prepares fingerprints, then checks only the approved discovery moments. You can cancel at any time."}
          preview={isPreview}
        />
        <div className="group-surface scan-group">
          <SourceRow source={source} />
          <div className="group-label-row">
            <span role="status" aria-live="polite">{progress?.stage ?? "Preparing local scan"}</span>
            <span>{isPreview ? "Preview only" : completedSteps + " of " + totalSteps}</span>
          </div>
          {!isPreview && (
            <div
              className="scan-progress-track"
              role="progressbar"
              aria-label="Local scan progress"
              aria-valuemin={0}
              aria-valuemax={totalSteps}
              aria-valuenow={completedSteps}
              aria-valuetext={(progress?.stage ?? "Preparing local scan") + ". " + (progress?.detail ?? completedSteps + " of " + totalSteps + " scan steps complete")}
            >
              <span style={{ width: (completedSteps / totalSteps) * 100 + "%" }} />
            </div>
          )}
          {isPreview ? (
            <ol className="sample-list">
              {plannedSteps.map((step, position) => (
                <li className="sample-row" key={step.kind + "-" + step.index}>
                  <span className="sample-index">{String(position + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                  </span>
                  <span className="sample-status">Prepared</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="sample-row sample-row--current" role="status" aria-live="polite">
              <span className="sample-index">{progress?.stage === "Mapping local activity" ? "Map" : "Scan"}</span>
              <span>
                <strong>{progress?.stage ?? "Preparing local scan"}</strong>
                <small>{progress?.detail ?? "Checking the selected source on this Mac."}</small>
              </span>
              <span className="sample-status">{progress?.stage === "Local scan complete" ? "Complete" : "Working"}</span>
            </div>
          )}
        </div>
        <div className="canvas-actions">
          <span className="quiet-note">{isPreview ? "Fixture-only data for development." : "Source video and temporary audio stay on this Mac."}</span>
          {isPreview && onNext ? (
            <Button type="button" onClick={onNext}>
              Review preview matches
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="secondary" type="button" onClick={onCancel}>
              Cancel scan
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

