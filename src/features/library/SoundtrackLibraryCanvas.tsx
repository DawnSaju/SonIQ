import { useEffect, useRef } from "react";
import { FolderOpen, History, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { createCueSheet, type SoundtrackRecord } from "../../lib/soundtrack";
import { formatSavedScanDate } from "../workspace/utils";
import { TrackArtwork } from "../soundtrack/TrackArtwork";

export function SoundtrackLibraryCanvas({
  records,
  onNewScan,
  onOpen,
  onDelete,
  deletedRecord,
  onUndoDelete,
}: {
  records: SoundtrackRecord[];
  onNewScan: () => void;
  onOpen: (record: SoundtrackRecord) => void;
  onDelete: (record: SoundtrackRecord) => void;
  deletedRecord: SoundtrackRecord | null;
  onUndoDelete: () => void;
}) {
  const undoDeleteRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (deletedRecord) undoDeleteRef.current?.focus();
  }, [deletedRecord]);

  return (
    <section className="library-view" aria-labelledby="screen-title">
      {records.length > 0 ? <>
        <header className="library-summary-header"><div><h1 id="screen-title" tabIndex={-1}>Soundtracks</h1><p>Minimal cue sheets and recovery receipts stay on this Mac.</p></div><Button type="button" onClick={onNewScan}><Plus size={15} aria-hidden="true" />New scan</Button></header>
        {deletedRecord && <div className="library-undo-toast" role="status"><span>{deletedRecord.source.fileName} was removed from SonIQ. Your original video was untouched.</span><button ref={undoDeleteRef} type="button" onClick={onUndoDelete}><Undo2 size={13} aria-hidden="true" />Undo</button></div>}
        <ul className="library-list" aria-label="Saved soundtracks">
          {records.map((record) => {
            const cueSheet = createCueSheet(record.entries);
            const artwork = record.entries.find((entry) => entry.artworkUrl);
            const summary = cueSheet.length ? cueSheet.length + " " + (cueSheet.length === 1 ? "kept track" : "kept tracks") : record.entries.length ? record.entries.length + " tracks to review" : "Empty soundtrack";
            return <li key={record.id}><div className="library-scan-row library-scan-row--record"><TrackArtwork candidate={artwork} variant="library" /><button className="library-scan-copy" type="button" onClick={() => onOpen(record)}><strong>{record.source.fileName}</strong><small>{formatSavedScanDate(record.updatedAt) + " · " + (record.source.durationLabel ?? "Source unavailable")}</small></button><span className={cueSheet.length ? "library-scan-status is-confirmed" : "library-scan-status status-muted"}>{summary}</span><div className="library-row-actions"><button className="quiet-action" type="button" onClick={() => onOpen(record)}><History size={14} aria-hidden="true" />Open</button><button className="quiet-action" type="button" onClick={() => onDelete(record)} aria-label={"Delete " + record.source.fileName}><Trash2 size={14} aria-hidden="true" /></button></div></div></li>;
          })}
        </ul>
      </> : <>
        {deletedRecord && <div className="library-undo-toast" role="status"><span>{deletedRecord.source.fileName} was removed from SonIQ. Your original video was untouched.</span><button ref={undoDeleteRef} type="button" onClick={onUndoDelete}><Undo2 size={13} aria-hidden="true" />Undo</button></div>}
        <div className="library-empty-state"><span className="source-drop-icon" aria-hidden="true"><FolderOpen size={36} strokeWidth={1.3} /></span><h2>No saved soundtracks</h2><p>When you scan or recover a moment, SonIQ saves a minimal local soundtrack record—not your source video.</p><Button type="button" onClick={onNewScan}><Plus size={16} aria-hidden="true" />New scan</Button></div>
      </>}
    </section>
  );
}

