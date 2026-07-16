import { Clipboard, Download, ExternalLink, ListMusic } from "lucide-react";
import { Button } from "../../components/ui/button";
import { createCueSheet, formatCueTimestamp, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatRangeList } from "../workspace/utils";
import { ScreenHeader } from "../scan/ScanCanvases";

export function CueSheetCanvas({
  record,
  copyState,
  exportState,
  onCopy,
  onExport,
  onOpenSpotify,
  onBack,
  onRestart,
}: {
  record: SoundtrackRecord;
  copyState: "" | "copied" | "unavailable";
  exportState: "" | "csv" | "json" | "unavailable";
  onCopy: () => void;
  onExport: (format: "csv" | "json") => void;
  onOpenSpotify: (entry: { title: string; artist: string }) => void;
  onBack: () => void;
  onRestart: () => void;
}) {
  const cueSheet = createCueSheet(record.entries);
  const receipt = record.receipt;
  const methods = receipt.methods.map((method) => method === "enhanced-recognition" ? "Enhanced recognition" : method === "acoustid" ? "AcoustID / MusicBrainz" : method === "manual" ? "Manual entry" : method).join(", ");
  const signatureRanges = receipt.enhancedRecognition.signatureTransfer?.signatureRanges ?? [];
  const enhancedBoundary = receipt.enhancedRecognition.signatureTransfer
    ? (signatureRanges.length
      ? signatureRanges.length + " approved recognition " + (signatureRanges.length === 1 ? "signature was" : "signatures were") + " sent for " + formatRangeList(signatureRanges) + ". Source video and raw PCM stayed local."
      : "A recognition signature was sent to the experimental, unofficial Shazam-compatible endpoint. Source video and raw PCM stayed local.")
    : receipt.enhancedRecognition.approval === "approved"
      ? "Enhanced recognition was approved. This saved receipt does not retain a request payload or raw provider response."
      : "Enhanced recognition was declined or not used for this recovery.";
  const completionFeedback = copyState === "copied"
    ? "Cue sheet copied."
    : copyState === "unavailable"
      ? "SonIQ could not reach the clipboard in this environment."
      : exportState === "csv"
        ? "CSV cue sheet saved."
        : exportState === "json"
          ? "JSON cue sheet saved."
          : exportState === "unavailable"
            ? "SonIQ could not save that cue sheet. Try another location."
            : "";

  return (
    <section className="workspace-canvas handoff-canvas" aria-labelledby="screen-title">
      <div className="canvas-main">
        <ScreenHeader
          title={cueSheet.length ? "Your timestamped cue sheet" : "Soundtrack saved without tracks"}
          detail={cueSheet.length ? "This is the portable record of the tracks you chose to keep. Exporting never includes source media or recognition payloads." : "You can revisit this record later, reconnect its source, or add tracks manually."}
        />
        <div className="cue-sheet-preview">
          <div className="cue-sheet-preview-header"><strong>{record.source.fileName}</strong><span>{cueSheet.length + " " + (cueSheet.length === 1 ? "kept track" : "kept tracks")}</span></div>
          {cueSheet.length ? <ul className="cue-sheet-list" aria-label="Timestamped cue sheet">
            {cueSheet.map((entry) => <li className="cue-sheet-row" key={entry.id}><span className="cue-sheet-time">{formatCueTimestamp(entry.timestampSeconds)}</span><span className="cue-sheet-copy"><strong>{entry.title}</strong><small>{entry.artist + (entry.state === "edited" ? " · corrected" : entry.state === "manual" ? " · manual" : "")}</small></span><button className="quiet-action" type="button" onClick={() => onOpenSpotify(entry)} title={"Search " + entry.title + " on Spotify"}><ExternalLink size={13} aria-hidden="true" />Spotify</button></li>)}
          </ul> : <div className="empty-review-state"><span className="library-icon" aria-hidden="true"><ListMusic size={23} /></span><h2>No tracks were kept</h2><p>This is still a valid local soundtrack record. Add or recover tracks whenever you are ready.</p></div>}
        </div>
        <div className="group-surface handoff-group">
          <div className="handoff-row"><span className="handoff-icon" aria-hidden="true"><Clipboard size={18} /></span><span><strong>Copy cue sheet</strong><small>Plain text with timestamps for credits, notes, or any editor.</small></span><Button variant="secondary" type="button" onClick={onCopy} disabled={!cueSheet.length}>{copyState === "copied" ? "Copied" : "Copy"}</Button></div>
          <div className="handoff-row"><span className="handoff-icon" aria-hidden="true"><Download size={18} /></span><span><strong>Export a portable file</strong><small>CSV and JSON include only kept entries and their display-ready details.</small></span><div className="handoff-actions"><Button variant="secondary" type="button" onClick={() => onExport("csv")} disabled={!cueSheet.length}>{exportState === "csv" ? "Saved CSV" : "CSV"}</Button><Button variant="secondary" type="button" onClick={() => onExport("json")} disabled={!cueSheet.length}>{exportState === "json" ? "Saved JSON" : "JSON"}</Button></div></div>
        </div>
        <p className="copy-feedback" role="status" aria-live="polite">{completionFeedback}</p>
        <details className="receipt-surface">
          <summary>Recognition receipt <span>Local and inspectable</span></summary>
          <ul className="receipt-list">
            <li className="receipt-row"><span>Source</span><strong>{record.source.fileName}</strong></li>
            <li className="receipt-row"><span>Ranges</span><span>{receipt.selectedRanges.length ? receipt.selectedRanges.map((range) => formatCueTimestamp(range.startSeconds) + "–" + formatCueTimestamp(range.endSeconds)).join(", ") : "No range metadata retained"}</span></li>
            <li className="receipt-row"><span>Lookup paths</span><span>{methods || "No external lookup result"}</span></li>
            <li className="receipt-row"><span>Enhanced boundary</span><span>{enhancedBoundary}</span></li>
            <li className="receipt-row"><span>Temporary artifacts</span><span>{receipt.temporaryArtifacts === "cleaned" ? "Local temporary files were cleaned up" : "No temporary media is stored in this record"}</span></li>
          </ul>
        </details>
        <div className="canvas-actions"><span className="quiet-note">No Spotify account, playlist creation, or paid service is required.</span><Button variant="secondary" type="button" onClick={onBack}>Back to review</Button><Button variant="secondary" type="button" onClick={onRestart}>Start another scan</Button></div>
      </div>
    </section>
  );
}

