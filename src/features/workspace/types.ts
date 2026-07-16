import type { RuntimeSoundtrackMap, TargetedRange } from "../../lib/soundtrack-map";
import type { SoundtrackEntry } from "../../lib/soundtrack";

export type AppScreen = "import" | "pending" | "scanning" | "review" | "moments" | "handoff";
export type AppView = "scan" | "library" | "settings";
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export type SourceVideo = { fileName: string; duration: string; path?: string; durationSeconds?: number; isFixture?: boolean };
export type VideoInfo = { fileName: string; durationSeconds: number; durationLabel: string };
export type ScanProgress = { stage: string; detail: string; completedSamples: number; totalSamples: number };
export type CandidateTrack = {
  id: string;
  title: string;
  artist: string;
  score: number;
  confidence: string;
  timestamps: number[];
  musicbrainzId?: string | null;
  artworkUrl?: string | null;
  lookupSource: string;
};
export type TrackPreview = {
  previewUrl: string | null;
  trackViewUrl: string | null;
  attribution: string;
};
export type ActiveTrackPreview = {
  entryId: string;
  preview: TrackPreview;
  playing: boolean;
};
export type LocalScanResult = {
  source: VideoInfo;
  samples?: ScanSample[];
  candidates: CandidateTrack[];
  recognitionStatus: "complete" | "notConfigured" | "partialFailure" | "pipelineFailed";
  message: string;
  enhancedRecognitionAttempted?: boolean;
  enhancedSignatureSubmitted?: boolean;
  enhancedSignatureRanges?: TargetedRange[];
  soundtrackMap?: RuntimeSoundtrackMap;
  temporaryArtifacts?: "cleaned" | "not-created" | "unknown";
};
export type ScanSample = { timestampSeconds: number; durationSeconds: number; status: string; message?: string | null };
export type WaveformEnvelope = {
  source: VideoInfo;
  startSeconds: number;
  endSeconds: number;
  bucketDurationSeconds: number;
  amplitudes: number[];
};
export type ActiveSoundtrackMap = { recordId: string; map: RuntimeSoundtrackMap };
export type EntryEdits = Pick<SoundtrackEntry, "title" | "artist" | "album" | "note"> & { momentSeconds?: number | null };
