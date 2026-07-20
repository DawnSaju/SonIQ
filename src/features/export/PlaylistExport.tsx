import { useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { Clipboard, Download, ExternalLink, ListMusic, ChevronDown, ChevronRight, Check, AlertTriangle, PlayCircle, Music2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { createCueSheet, formatCueTimestamp, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatRangeList } from "../workspace/utils";
import { ScreenHeader } from "../scan/ScanCanvases";

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 15, scale: 0.98 },
  visible: { 
    opacity: 1, 
    y: 0, 
    scale: 1,
    transition: { type: "spring", bounce: 0, duration: 0.4 } 
  },
};

export function PlaylistExport({
  record,
  copyState,
  exportState,
  onCopy,
  onExport,
  onOpenSpotify,
  onBack,
  onRestart,
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
  record: SoundtrackRecord;
  copyState: "" | "copied" | "unavailable";
  exportState: "" | "csv" | "json" | "unavailable";
  onCopy: () => void;
  onExport: (format: "csv" | "json") => void;
  onOpenSpotify: (entry: { title: string; artist: string }) => void;
  onBack: () => void;
  onRestart: () => void;
  isSpotifyConnected: boolean;
  spotifyAuthLoading: boolean;
  spotifyExportState: "idle" | "loading" | "success" | "error";
  spotifyExportError: string | null;
  onSpotifyConnect: () => void;
  onSpotifyExport: () => void;
  exportPlatform: "spotify" | "youtube" | null;
  youtubeExportState: "idle" | "loading" | "success" | "error";
  youtubeExportError: string | null;
  onYouTubeExport: () => void;
}) {
  const [receiptOpen, setReceiptOpen] = useState(false);

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

  return (
    <section className="workspace-canvas handoff-canvas" aria-labelledby="screen-title">
      <motion.div 
        className="canvas-main"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div variants={itemVariants}>
          <ScreenHeader
            title={cueSheet.length ? "Your Playlist" : "Playlist saved without tracks"}
            detail={cueSheet.length ? "Export your discovered tracks directly to your favorite platform." : "You can revisit this record later, reconnect its source, or add tracks manually."}
          />
        </motion.div>

        {cueSheet.length > 0 && (
          <motion.div className="export-destinations" variants={itemVariants}>
            {/* Spotify Export Row */}
            <div className="export-row">
              <div className="export-row-info">
                <div className="export-icon"><Music2 size={18} strokeWidth={2.5} /></div>
                <div className="export-row-text">
                  <strong>Spotify</strong>
                  <small>Create a new playlist</small>
                </div>
              </div>
              <div className="export-action">
                {spotifyExportState === "error" && spotifyExportError && (
                  <span className="export-error-msg">{spotifyExportError}</span>
                )}
                {!isSpotifyConnected ? (
                  <button type="button" className="quiet-action" onClick={onSpotifyConnect} disabled={spotifyAuthLoading}>
                    {spotifyAuthLoading ? "Connecting..." : "Connect"}<ChevronRight size={14} aria-hidden="true" />
                  </button>
                ) : (
                  <button 
                    type="button" 
                    className={`quiet-action ${spotifyExportState === "error" ? "btn-error" : ""}`}
                    onClick={onSpotifyExport}
                    disabled={spotifyExportState === "loading" || spotifyExportState === "success"}
                  >
                    {spotifyExportState === "loading" ? "Exporting..." : 
                     spotifyExportState === "success" ? <><Check size={14}/>Exported</> :
                     spotifyExportState === "error" ? <><AlertTriangle size={14}/>Failed</> : <>Export<ChevronRight size={14} aria-hidden="true" /></>}
                  </button>
                )}
              </div>
            </div>

            {/* YouTube Export Row */}
            <div className="export-row">
              <div className="export-row-info">
                <div className="export-icon"><PlayCircle size={18} strokeWidth={2.5} /></div>
                <div className="export-row-text">
                  <strong>YouTube</strong>
                  <small>Create a video playlist</small>
                </div>
              </div>
              <div className="export-action">
                {youtubeExportState === "error" && youtubeExportError && (
                  <span className="export-error-msg">{youtubeExportError}</span>
                )}
                <button 
                  type="button" 
                  className={`quiet-action ${youtubeExportState === "error" ? "btn-error" : ""}`}
                  onClick={onYouTubeExport}
                  disabled={youtubeExportState === "loading" || youtubeExportState === "success"}
                >
                  {youtubeExportState === "loading" ? "Exporting..." : 
                   youtubeExportState === "success" ? <><Check size={14}/>Exported</> :
                   youtubeExportState === "error" ? <><AlertTriangle size={14}/>Failed</> : <>Export<ChevronRight size={14} aria-hidden="true" /></>}
                </button>
              </div>
            </div>
          </motion.div>
        )}

        <motion.div className="playlist-preview" variants={itemVariants}>
          <div className="playlist-preview-header">
            <strong>{record.source.fileName}</strong>
            <span>{cueSheet.length + " " + (cueSheet.length === 1 ? "track" : "tracks")}</span>
          </div>
          {cueSheet.length ? (
            <ul className="playlist-list" aria-label="Timestamped playlist">
              {cueSheet.map((entry) => (
                <motion.li 
                  className="playlist-row" 
                  key={entry.id}
                  whileHover={{ scale: 0.995 }}
                  whileTap={{ scale: 0.985 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <span className="playlist-time">{formatCueTimestamp(entry.timestampSeconds)}</span>
                  <span className="playlist-copy">
                    <strong>{entry.title}</strong>
                    <small>{entry.artist + (entry.state === "edited" ? " · corrected" : entry.state === "manual" ? " · manual" : "")}</small>
                  </span>
                  <button className="quiet-action" type="button" onClick={() => onOpenSpotify(entry)} title={"Search " + entry.title + " on Spotify"}>
                    <ExternalLink size={13} aria-hidden="true" />
                    <span>Search</span>
                  </button>
                </motion.li>
              ))}
            </ul>
          ) : (
            <motion.div 
              className="empty-review-state"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", bounce: 0.3, duration: 0.6 }}
            >
              <span className="library-icon" aria-hidden="true"><ListMusic size={28} /></span>
              <h2>No tracks were kept</h2>
              <p>This is still a valid local playlist record. Add or recover tracks whenever you are ready.</p>
            </motion.div>
          )}
        </motion.div>

        <motion.div className="advanced-options" variants={itemVariants}>
          <div className="advanced-links">
            <button className="advanced-link" onClick={onCopy}>{copyState === "copied" ? "Copied to clipboard" : "Copy as text"}</button>
            <span className="advanced-divider">·</span>
            <button className="advanced-link" onClick={() => onExport("csv")}>{exportState === "csv" ? "Saved CSV" : "Export CSV"}</button>
            <span className="advanced-divider">·</span>
            <button className="advanced-link" onClick={() => onExport("json")}>{exportState === "json" ? "Saved JSON" : "Export JSON"}</button>
            <span className="advanced-divider">·</span>
            <button className="advanced-link" onClick={() => setReceiptOpen(!receiptOpen)}>
              {receiptOpen ? "Hide Receipt" : "View Receipt"}
            </button>
          </div>
          
          <AnimatePresence initial={false}>
            {receiptOpen && (
              <motion.div 
                className="receipt-content-wrapper"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: "spring", bounce: 0, duration: 0.4 }}
              >
                <ul className="receipt-list">
                  <li className="receipt-row"><span>Source</span><strong>{record.source.fileName}</strong></li>
                  <li className="receipt-row"><span>Ranges</span><span>{receipt.selectedRanges.length ? receipt.selectedRanges.map((range) => formatCueTimestamp(range.startSeconds) + "–" + formatCueTimestamp(range.endSeconds)).join(", ") : "No range metadata retained"}</span></li>
                  <li className="receipt-row"><span>Lookup paths</span><span>{methods || "No external lookup result"}</span></li>
                  <li className="receipt-row"><span>Enhanced boundary</span><span>{enhancedBoundary}</span></li>
                  <li className="receipt-row"><span>Temporary artifacts</span><span>{receipt.temporaryArtifacts === "cleaned" ? "Local temporary files were cleaned up" : "No temporary media is stored in this record"}</span></li>
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <motion.div className="canvas-actions" variants={itemVariants}>
          <Button variant="secondary" type="button" onClick={onBack}>Back to review</Button>
          <Button variant="secondary" type="button" onClick={onRestart}>Start another scan</Button>
        </motion.div>
      </motion.div>
    </section>
  );
}
