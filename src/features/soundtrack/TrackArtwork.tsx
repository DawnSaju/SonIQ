import { useState } from "react";
import { Music2, Pause, Play } from "lucide-react";

export function TrackArtwork({
  candidate,
  variant = "review",
  preview,
}: {
  candidate?: { artworkUrl?: string | null };
  variant?: "review" | "library";
  preview?: { loading: boolean; playing: boolean; label: string; onToggle: () => void };
}) {
  const [failed, setFailed] = useState(false);
  const artwork = candidate?.artworkUrl && !failed ? (
    <img src={candidate.artworkUrl} alt="" onError={() => setFailed(true)} />
  ) : (
    <Music2 size={17} strokeWidth={1.65} />
  );

  if (preview) {
    return (
      <button
        className={"track-artwork track-artwork--" + variant + " track-artwork--preview"}
        type="button"
        data-loading={preview.loading}
        data-playing={preview.playing}
        aria-label={preview.label}
        aria-pressed={preview.playing}
        disabled={preview.loading}
        onClick={preview.onToggle}
      >
        {artwork}
        <span className="track-artwork-preview-overlay" aria-hidden="true">
          {preview.loading ? <span className="track-artwork-preview-loading">•••</span> : preview.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </span>
      </button>
    );
  }

  return (
    <span className={"track-artwork track-artwork--" + variant} aria-hidden="true">
      {artwork}
    </span>
  );
}

