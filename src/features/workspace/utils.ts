import { isTauri } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { developmentFixture } from "../../lib/fixture";
import type { TargetedRange } from "../../lib/soundtrack-map";
import { removeSoniqOwnedStorage } from "../../lib/workspace-settings";
import {
  createEntriesFromRecognitionCandidates,
  createSoundtrackId,
  createSoundtrackRecord,
  migrateSoundtrackHistory,
  serializeSoundtrackHistory,
  type RecognitionMethod,
  type RecognitionReceipt,
  type SoundtrackRecord,
  type TimeRange,
} from "../../lib/soundtrack";
import type {
  AppScreen,
  CandidateTrack,
  LocalScanResult,
  SourceVideo,
  Theme,
  ThemePreference,
} from "./types";

export const libraryStore = new LazyStore("library.json");

export const previewScreens: AppScreen[] = ["import", "pending", "scanning", "review", "handoff"];
export const onboardingKey = "soniq:onboarding-v4-complete";
export const nameKey = "soniq:display-name";
export const themeKey = "soniq:theme";
export const scanHistoryKey = "soniq:scan-history-v1";
export const soundtrackHistoryKey = "soniq:soundtrack-library-v2";
export const maxSavedScans = 50;
export const supportedExtensions = [".mp4", ".mov", ".m4v"];
export const fixtureCandidates: CandidateTrack[] = developmentFixture.candidates.map((candidate, index) => ({
  ...candidate,
  id: "fixture-" + index,
  score: candidate.confidence === "High confidence" ? 0.92 : 0.74,
  timestamps: [Number(developmentFixture.samples[index].split(":")[0]) * 60 + Number(developmentFixture.samples[index].split(":")[1])],
  lookupSource: "Development fixture",
}));

export function readLocal(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
  }
}

export function removeLocal(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
  }
}

export async function resetSoniqOwnedStorage() {
  try {
    removeSoniqOwnedStorage(window.localStorage);
    if (isTauri()) {
      await libraryStore.clear();
      await libraryStore.save();
    }
  } catch {
  }
}


export function parseStoredArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function readSoundtrackRecords(): Promise<SoundtrackRecord[]> {
  let legacyRecords: SoundtrackRecord[] = [];
  const storedCurrent = readLocal(soundtrackHistoryKey);
  if (storedCurrent !== null) {
    try {
      const current: unknown = JSON.parse(storedCurrent);
      if (Array.isArray(current)) legacyRecords = migrateSoundtrackHistory(current).records;
    } catch { }
  } else {
    legacyRecords = migrateSoundtrackHistory(parseStoredArray(readLocal(scanHistoryKey))).records;
  }

  if (isTauri()) {
    try {
      let migrationOccurred = false;
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key?.startsWith("soniq:source-bookmark:")) {
          const bookmark = window.localStorage.getItem(key);
          if (bookmark) {
            await libraryStore.set(key, bookmark);
            migrationOccurred = true;
          }
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) window.localStorage.removeItem(key);

      const records = await libraryStore.get<SoundtrackRecord[]>("records");

      if (!records || !Array.isArray(records)) {
        if (legacyRecords.length > 0) {
          await libraryStore.set("records", legacyRecords);
          migrationOccurred = true;
        }
      }

      if (migrationOccurred) {
        await libraryStore.save();
      }

      if (records && Array.isArray(records)) return migrateSoundtrackHistory(records).records;
    } catch {
      // Store failed to load, so we will fall back to returning the legacy payload
    }
  }

  return legacyRecords;
}

export async function persistSoundtrackRecords(records: SoundtrackRecord[]) {
  if (isTauri()) {
    try {
      await libraryStore.set("records", records);
      await libraryStore.save();
    } catch {
      // Ignore the errors only if the window is closed
    }
  } else {
    writeLocal(soundtrackHistoryKey, serializeSoundtrackHistory(records));
  }
}

export function recognitionMethodForCandidate(candidate: CandidateTrack): RecognitionMethod {
  const source = candidate.lookupSource.toLowerCase();
  if (source.includes("shazam") || source.includes("enhanced")) return "enhanced-recognition";
  if (source.includes("acoustid") || source.includes("musicbrainz")) return "acoustid";
  if (source.includes("fixture")) return "development-fixture";
  return "unknown";
}

export function sourceRangesFromResult(result: LocalScanResult, targetedRange?: TargetedRange): TimeRange[] {
  if (targetedRange) return [targetedRange];

  const standardRanges = (result.samples ?? [])
    .filter((sample) => sample.status !== "failed")
    .map((sample) => ({
      startSeconds: sample.timestampSeconds,
      endSeconds: sample.timestampSeconds + Math.max(sample.durationSeconds, 0),
    }))
    .filter((range) => range.endSeconds > range.startSeconds);

  if (standardRanges.length > 0) return standardRanges;

  return (result.enhancedSignatureRanges ?? [])
    .filter(
      (range) =>
        Number.isFinite(range.startSeconds) &&
        Number.isFinite(range.endSeconds) &&
        range.startSeconds >= 0 &&
        range.endSeconds > range.startSeconds,
    )
    .map((range) => ({ startSeconds: range.startSeconds, endSeconds: range.endSeconds }));
}

export function receiptForResult(result: LocalScanResult, enhancedRecognition: boolean, targetedRange?: TargetedRange): RecognitionReceipt {
  const methods = Array.from(new Set(result.candidates.map(recognitionMethodForCandidate)));
  const candidateCount = result.candidates.length;
  const enhancedAttempted = result.enhancedRecognitionAttempted ?? false;
  const signatureSubmitted = result.enhancedSignatureSubmitted ?? false;
  const signatureRanges = (result.enhancedSignatureRanges ?? [])
    .filter((range) => Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds) && range.endSeconds > range.startSeconds)
    .slice(0, 12);

  return {
    id: createSoundtrackId("receipt"),
    completedAt: new Date().toISOString(),
    selectedRanges: sourceRangesFromResult(result, targetedRange),
    methods: methods.length > 0 ? methods : enhancedAttempted ? ["enhanced-recognition"] : ["unknown"],
    outcome:
      result.recognitionStatus === "pipelineFailed"
        ? "pipeline-failed"
        : result.recognitionStatus === "partialFailure"
          ? "partial-failure"
          : candidateCount > 0
            ? "matches-found"
            : "no-match",
    candidateCount,
    temporaryArtifacts: result.temporaryArtifacts ?? "unknown",
    enhancedRecognition: {
      approval: enhancedRecognition ? "approved" : "declined",
      ...(signatureSubmitted
        ? {
          signatureTransfer: {
            destination: "unofficial-shazam-compatible" as const,
            dataType: "recognition-signature" as const,
            sourceVideoTransferred: false as const,
            rawPcmTransferred: false as const,
            retainedBySonIQ: false as const,
            ...(signatureRanges.length > 0 ? { signatureRanges } : {}),
          },
        }
        : {}),
    },
  };
}

export function recordForResult(result: LocalScanResult, enhancedRecognition: boolean, targetedRange?: TargetedRange): SoundtrackRecord {
  const createdAt = new Date().toISOString();
  const id = createSoundtrackId("soundtrack");
  return createSoundtrackRecord({
    id,
    source: result.source,
    entries: createEntriesFromRecognitionCandidates(result.candidates, { recordId: id, createdAt }),
    receipt: receiptForResult(result, enhancedRecognition, targetedRange),
    sourceAvailability: { state: "available-in-session", checkedAt: createdAt },
    createdAt,
    updatedAt: createdAt,
  });
}


export function getInitialScreen(): AppScreen {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("preview");

  if (import.meta.env.DEV && previewScreens.includes(requested as AppScreen)) {
    return requested as AppScreen;
  }

  return "import";
}

export function getInitialOnboarding() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("onboarding") === "1") return true;
  if (params.get("onboarding") === "0" || params.has("preview")) return false;
  return readLocal(onboardingKey) !== "true";
}

export function getSystemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}


export function getInitialThemePreference(): ThemePreference {
  const saved = readLocal(themeKey);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function isSupportedVideo(file: File) {
  return file.type.startsWith("video/") || supportedExtensions.some((extension) => file.name.toLowerCase().endsWith(extension));
}

export function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  return String(Math.floor(rounded / 60)).padStart(2, "0") + ":" + String(rounded % 60).padStart(2, "0");
}

export const enhancedSignatureSeconds = 8;
export const maxEnhancedDiscoverySignatures = 6;
export const maxEnhancedTargetedSignatures = 4;

/** Mirrors the bounded Rust planner so consent copy always matches real requests. */
export function planEnhancedSignatureRanges(startSeconds: number, durationSeconds: number, maximumSignatures: number): TargetedRange[] {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || maximumSignatures <= 0) return [];

  const signatureDuration = Math.min(enhancedSignatureSeconds, durationSeconds);
  if (durationSeconds <= enhancedSignatureSeconds) {
    return [{ startSeconds, endSeconds: startSeconds + signatureDuration }];
  }

  const nominalCount = Math.ceil(durationSeconds / enhancedSignatureSeconds);
  const count = Math.min(Math.max(nominalCount, 1), maximumSignatures);
  const lastStartOffset = Math.max(durationSeconds - signatureDuration, 0);
  const shouldDistribute = nominalCount > maximumSignatures && count > 1;

  return Array.from({ length: count }, (_, index) => {
    const offset = shouldDistribute
      ? lastStartOffset * index / (count - 1)
      : index + 1 === count
        ? lastStartOffset
        : Math.min(index * enhancedSignatureSeconds, lastStartOffset);
    return { startSeconds: startSeconds + offset, endSeconds: startSeconds + offset + signatureDuration };
  });
}

export function plannedEnhancedTargetedRanges(range: TargetedRange) {
  return planEnhancedSignatureRanges(range.startSeconds, range.endSeconds - range.startSeconds, maxEnhancedTargetedSignatures);
}


export function plannedLocalSampleCount(source: Pick<SourceVideo, "durationSeconds">) {
  const duration = source.durationSeconds;
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 3;
  return duration >= 24 ? 3 : Math.max(Math.floor(duration / 8), 1);
}

export function formatTimeRange(range: TargetedRange) {
  return formatTimestamp(range.startSeconds) + "–" + formatTimestamp(range.endSeconds);
}

export function formatRangeList(ranges: readonly TargetedRange[]) {
  return ranges.map(formatTimeRange).join(" · ");
}

export function mergeTimeRanges(...rangeLists: readonly (readonly TargetedRange[])[]) {
  const ranges = new Map<string, TargetedRange>();
  for (const range of rangeLists.flat()) {
    if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds) || range.endSeconds <= range.startSeconds) continue;
    ranges.set(range.startSeconds + ":" + range.endSeconds, { startSeconds: range.startSeconds, endSeconds: range.endSeconds });
  }
  return [...ranges.values()].sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
}

export function pluralizeMoments(count: number) {
  return count === 1 ? "moment" : "moments";
}

export function formatSavedScanDate(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Saved on this Mac";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
