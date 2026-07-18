import { useEffect, useRef, useState } from "react";
import { FolderOpen, History, Plus, Trash2, Undo2, Pencil, Play } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "../../components/ui/button";
import { createCueSheet, type SoundtrackRecord, type SoundtrackEntry } from "../../lib/soundtrack";
import { formatSavedScanDate } from "../workspace/utils";
import { TrackArtwork } from "../soundtrack/TrackArtwork";

export function SoundtrackLibraryCanvas({
  records,
  viewMode,
  onNewScan,
  onOpen,
  onDelete,
  onRename,
  onSetCover,
  deletedRecord,
  onUndoDelete,
}: {
  records: SoundtrackRecord[];
  viewMode: "list" | "grid";
  onNewScan: () => void;
  onOpen: (record: SoundtrackRecord) => void;
  onDelete: (record: SoundtrackRecord) => void;
  onRename: (record: SoundtrackRecord, newName: string) => void;
  onSetCover: (record: SoundtrackRecord, coverEntryId: string) => void;
  deletedRecord: SoundtrackRecord | null;
  onUndoDelete: () => void;
}) {
  const undoDeleteRef = useRef<HTMLButtonElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pickingCoverId, setPickingCoverId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  function startEdit(record: SoundtrackRecord, event: React.MouseEvent) {
    event.stopPropagation();
    setEditingId(record.id);
    setEditName(record.source.fileName);
  }

  function submitEdit(record: SoundtrackRecord) {
    onRename(record, editName);
    setEditingId(null);
  }

  function handleKeyDown(e: React.KeyboardEvent, record: SoundtrackRecord) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitEdit(record);
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  }

  useEffect(() => {
    if (deletedRecord) undoDeleteRef.current?.focus();
  }, [deletedRecord]);

  return (
    <section className="library-view" aria-labelledby="screen-title">
      <h1 id="screen-title" className="sr-only" tabIndex={-1}>Library</h1>
      {records.length > 0 ? <>
        {deletedRecord && <div className="library-undo-toast" role="status"><span>{deletedRecord.source.fileName} was removed from SonIQ. Your original video was untouched.</span><button ref={undoDeleteRef} type="button" onClick={onUndoDelete}><Undo2 size={13} aria-hidden="true" />Undo</button></div>}
        <motion.ul 
          layout
          className={viewMode === "grid" ? "library-grid" : "library-list"} 
          aria-label="Saved soundtracks"
        >
          <AnimatePresence initial={false}>
            {records.map((record) => {
              const cueSheet = createCueSheet(record.entries);
              const artwork = record.entries.find(e => e.id === record.coverEntryId) || record.entries.find(e => e.artworkUrl);
              const availableCovers = record.entries.filter(e => e.artworkUrl).length;
              const summary = cueSheet.length ? cueSheet.length + " " + (cueSheet.length === 1 ? "kept track" : "kept tracks") : record.entries.length ? record.entries.length + " tracks to review" : "Empty soundtrack";
              
              if (viewMode === "grid") {
                return (
                  <motion.li 
                    layout="position"
                    key={record.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                    transition={{ type: "spring", bounce: 0, duration: 0.4 }}
                  >
                    <div className="library-grid-card">
                      <div className="library-grid-artwork-container" onClick={() => onOpen(record)}>
                        <TrackArtwork candidate={artwork} variant="library" />
                        <div className="library-grid-artwork-overlay">
                          <Play size={20} fill="currentColor" />
                        </div>
                        {availableCovers > 1 && (
                          <button className="library-artwork-edit-btn" type="button" onClick={(e) => { e.stopPropagation(); setPickingCoverId(record.id); }}>
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                      
                      <div className="library-grid-content">
                        {editingId === record.id ? (
                          <input
                            autoFocus
                            className="library-rename-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={() => submitEdit(record)}
                            onKeyDown={(e) => handleKeyDown(e, record)}
                            style={{ margin: "0 0 4px 0" }}
                          />
                        ) : (
                          <strong className="library-grid-title" onClick={() => onOpen(record)}>{record.source.fileName}</strong>
                        )}
                        <small className="library-grid-subtitle">{formatSavedScanDate(record.updatedAt)}</small>
                        <span className={cueSheet.length ? "library-scan-status is-confirmed" : "library-scan-status status-muted"} style={{ alignSelf: "flex-start", marginTop: 4 }}>{summary}</span>
                      </div>
                      
                      <div className="library-grid-actions">
                        <button className="quiet-action" type="button" onClick={(e) => startEdit(record, e)} aria-label={"Rename " + record.source.fileName}><Pencil size={14} aria-hidden="true" /></button>
                        <button className="quiet-action" type="button" onClick={() => onDelete(record)} aria-label={"Delete " + record.source.fileName}><Trash2 size={14} aria-hidden="true" /></button>
                      </div>
                    </div>
                  </motion.li>
                );
              }

              return (
                <motion.li 
                  layout="position"
                  key={record.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  transition={{ type: "spring", bounce: 0, duration: 0.4 }}
                >
                  <div className="library-scan-row library-scan-row--record" onClick={() => onOpen(record)}>
                    <div className="library-list-artwork-container">
                      <TrackArtwork candidate={artwork} variant="library" />
                      {availableCovers > 1 && (
                        <button className="library-artwork-edit-btn" type="button" onClick={(e) => { e.stopPropagation(); setPickingCoverId(record.id); }}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                    {editingId === record.id ? (
                      <div className="library-scan-copy" style={{ zIndex: 10 }}>
                        <input
                          autoFocus
                          className="library-rename-input"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => submitEdit(record)}
                          onKeyDown={(e) => handleKeyDown(e, record)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <small>{formatSavedScanDate(record.updatedAt) + " · " + (record.source.durationLabel ?? "Source unavailable")}</small>
                      </div>
                    ) : (
                      <div className="library-scan-copy"><strong>{record.source.fileName}</strong><small>{formatSavedScanDate(record.updatedAt) + " · " + (record.source.durationLabel ?? "Source unavailable")}</small></div>
                    )}
                    <span className={cueSheet.length ? "library-scan-status is-confirmed" : "library-scan-status status-muted"}>{summary}</span><div className="library-row-actions"><button className="quiet-action" type="button" onClick={(e) => startEdit(record, e)} aria-label={"Rename " + record.source.fileName}><Pencil size={14} aria-hidden="true" />Rename</button><button className="quiet-action" type="button" onClick={() => onOpen(record)}><History size={14} aria-hidden="true" />Open</button><button className="quiet-action" type="button" onClick={() => onDelete(record)} aria-label={"Delete " + record.source.fileName}><Trash2 size={14} aria-hidden="true" /></button></div>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </motion.ul>
      </> : <>
        {deletedRecord && <div className="library-undo-toast" role="status"><span>{deletedRecord.source.fileName} was removed from SonIQ. Your original video was untouched.</span><button ref={undoDeleteRef} type="button" onClick={onUndoDelete}><Undo2 size={13} aria-hidden="true" />Undo</button></div>}
        <div className="library-empty-state"><span className="source-drop-icon" aria-hidden="true"><FolderOpen size={36} strokeWidth={1.3} /></span><h2>No saved soundtracks</h2><p>When you scan or recover a moment, SonIQ saves a minimal local soundtrack record—not your source video.</p><Button type="button" onClick={onNewScan}><Plus size={16} aria-hidden="true" />New scan</Button></div>
      </>}

      <AnimatePresence>
        {pickingCoverId && (
          <CoverGalleryPopover
            record={records.find(r => r.id === pickingCoverId)!}
            onClose={() => setPickingCoverId(null)}
            onSelect={(entryId) => {
              onSetCover(records.find(r => r.id === pickingCoverId)!, entryId);
              setPickingCoverId(null);
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function CoverGalleryPopover({
  record,
  onClose,
  onSelect
}: {
  record: SoundtrackRecord;
  onClose: () => void;
  onSelect: (entryId: string) => void;
}) {
  const artworks = record.entries.filter(e => e.artworkUrl);
  return (
    <div className="cover-popover-scrim" onClick={onClose}>
      <motion.div
        className="cover-popover"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", bounce: 0, duration: 0.3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-popover-header">
          <span>Choose Cover</span>
        </div>
        <div className="cover-popover-grid">
          {artworks.map(entry => (
            <button 
              type="button" 
              key={entry.id} 
              className="cover-popover-item" 
              onClick={() => onSelect(entry.id)}
            >
              <TrackArtwork candidate={entry} variant="library" />
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
