export const SOUNDTRACK_SCHEMA_VERSION = 2 as const;

const DEFAULT_ARTIST = "Unknown artist";
const MAX_TEXT_LENGTH = 500;
const MAX_NOTE_LENGTH = 2_000;
const MAX_RECORDS = 50;
const MAX_ENTRIES_PER_RECORD = 200;
const MAX_RANGES_PER_ENTRY = 12;
const MAX_SIGNATURE_RANGES = 12;
const FALLBACK_RECOGNITION_SAMPLE_SECONDS = 8;
const RECOGNITION_IDENTITY_DELIMITER = "\u001f";

export type RecoveryState = "suggested" | "confirmed" | "edited" | "manual" | "removed";
export type EntrySelection = "kept" | "not-kept";
export type RecognitionMethod = "acoustid" | "enhanced-recognition" | "development-fixture" | "manual" | "unknown";
export type MomentPrecision = "exact" | "approximate" | "user-assigned";
export type SourceAvailabilityState = "unknown" | "available-in-session" | "reconnect-needed";
export type ReceiptOutcome = "matches-found" | "no-match" | "partial-failure" | "pipeline-failed" | "cancelled";

export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

export interface SoundtrackMoment {
  startSeconds: number;
  endSeconds?: number;
  precision: MomentPrecision;
}

/** Display-only source information. A local path deliberately has no home here. */
export interface SourceDisplayMetadata {
  fileName: string;
  durationSeconds?: number;
  durationLabel?: string;
}

/**
 * Source accessibility is transient context, never a persisted path. A caller
 * should retain an actual source handle separately for the active app session.
 */
export interface SourceAvailability {
  state: SourceAvailabilityState;
  checkedAt?: string;
}

export interface RecognitionEvidence {
  method: RecognitionMethod;
  lookupSource: string;
  confidence?: string;
  score?: number;
  sampleRanges: TimeRange[];
  /** A normalized catalogue identifier, never a raw provider response. */
  catalogReference?: {
    provider: "musicbrainz";
    id: string;
  };
}

export interface OriginalSuggestion {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
}

export interface UserCorrections {
  title?: string;
  artist?: string;
  album?: string;
  moment?: SoundtrackMoment;
  note?: string;
}

export interface SoundtrackEntry {
  id: string;
  state: RecoveryState;
  /** Explicit user decision. Suggested rows are never exported by default. */
  selection: EntrySelection;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  moment?: SoundtrackMoment;
  note?: string;
  originalSuggestion?: OriginalSuggestion;
  corrections?: UserCorrections;
  evidence?: RecognitionEvidence;
  createdAt: string;
  updatedAt: string;
}

export interface RecognitionReceipt {
  id: string;
  completedAt: string;
  selectedRanges: TimeRange[];
  methods: RecognitionMethod[];
  outcome: ReceiptOutcome;
  candidateCount: number;
  temporaryArtifacts: "cleaned" | "not-created" | "unknown";
  enhancedRecognition: {
    approval: "approved" | "declined" | "not-used" | "unknown";
    /** Present only when the approved adapter submitted a recognition signature. */
    signatureTransfer?: {
      destination: "unofficial-shazam-compatible";
      dataType: "recognition-signature";
      sourceVideoTransferred: false;
      rawPcmTransferred: false;
      retainedBySonIQ: false;
      /**
       * Compact, local-only evidence of each approved bounded signature range.
       * It never contains audio, a fingerprint, or a provider response.
       */
      signatureRanges?: TimeRange[];
    };
  };
}

export interface SoundtrackRecord {
  schemaVersion: typeof SOUNDTRACK_SCHEMA_VERSION;
  id: string;
  source: SourceDisplayMetadata;
  sourceAvailability: SourceAvailability;
  entries: SoundtrackEntry[];
  receipt: RecognitionReceipt;
  coverEntryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSoundtrackRecordInput {
  id?: string;
  source: SourceDisplayMetadata;
  entries: readonly SoundtrackEntry[];
  receipt?: RecognitionReceipt;
  sourceAvailability?: SourceAvailability;
  coverEntryId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CueSheetEntry {
  id: string;
  timestampSeconds?: number;
  title: string;
  artist: string;
  album?: string;
  state: "confirmed" | "edited" | "manual";
  origin: "recognized" | "manual";
  note?: string;
}

export type CueSheetFormat = "txt" | "csv" | "json";

type UnknownRecord = Record<string, unknown>;

interface LegacyCandidate {
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  score?: unknown;
  confidence?: unknown;
  timestamps?: unknown;
  musicbrainzId?: unknown;
  artworkUrl?: unknown;
  lookupSource?: unknown;
}

interface LegacySavedScan {
  id?: unknown;
  source?: unknown;
  createdAt?: unknown;
  candidates?: unknown;
  acceptedIds?: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function text(value: unknown, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function canonicalRecognitionPart(value: string | null | undefined): string {
  const safeValue = text(value) ?? "";
  return safeValue
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A stable, display-field-only identity for merging recognition candidates.
 * The separator is not allowed in either normalized component, preventing
 * title/artist boundary collisions such as `A / B` vs. `A` / `B`.
 */
export function canonicalRecognitionIdentity(title: string | null | undefined, artist: string | null | undefined): string {
  return canonicalRecognitionPart(title) + RECOGNITION_IDENTITY_DELIMITER + canonicalRecognitionPart(artist);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function isoDate(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return Number.isNaN(new Date(value).getTime()) ? fallback : value;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stableFallbackId(prefix: string, index: number): string {
  return prefix + "-" + String(index + 1);
}

function sanitizeTimeRange(value: unknown): TimeRange | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const startSeconds = nonNegativeNumber(raw.startSeconds);
  const endSeconds = nonNegativeNumber(raw.endSeconds);
  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) return undefined;
  return { startSeconds, endSeconds };
}

function sanitizeTimeRanges(value: unknown, limit = MAX_RANGES_PER_ENTRY): TimeRange[] {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizeTimeRange).filter((range): range is TimeRange => Boolean(range)).slice(0, limit);
}

/**
 * Recognition providers only return a matched timestamp, not the exact
 * analysis duration. Preserve every valid timestamp as minimal 8-second local
 * evidence so review, recovery, and export order can still explain the match.
 */
function sampleRangesFromTimestamps(timestamps: readonly number[]): TimeRange[] {
  return timestamps
    .map(nonNegativeNumber)
    .filter((timestamp): timestamp is number => timestamp !== undefined)
    .map((startSeconds) => ({ startSeconds, endSeconds: startSeconds + FALLBACK_RECOGNITION_SAMPLE_SECONDS }))
    .filter((range) => Number.isFinite(range.endSeconds))
    .slice(0, MAX_RANGES_PER_ENTRY);
}

function sanitizeMoment(value: unknown): SoundtrackMoment | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const startSeconds = nonNegativeNumber(raw.startSeconds);
  if (startSeconds === undefined) return undefined;
  const endSeconds = nonNegativeNumber(raw.endSeconds);
  if (endSeconds !== undefined && endSeconds <= startSeconds) return undefined;
  const precision = raw.precision === "exact" || raw.precision === "approximate" || raw.precision === "user-assigned" ? raw.precision : "approximate";
  return endSeconds === undefined ? { startSeconds, precision } : { startSeconds, endSeconds, precision };
}

function sanitizeSource(value: unknown): SourceDisplayMetadata | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const fileName = sourceDisplayName(raw.fileName);
  if (!fileName) return undefined;
  const durationSeconds = nonNegativeNumber(raw.durationSeconds);
  const durationLabel = text(raw.durationLabel, 80);
  return {
    fileName,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(durationLabel === undefined ? {} : { durationLabel }),
  };
}

/** Never allow a legacy or malformed display field to preserve a local path. */
function sourceDisplayName(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  const pathParts = candidate.split(/[\\/]+/).filter(Boolean);
  return text(pathParts[pathParts.length - 1]);
}

function sanitizeSourceAvailability(value: unknown): SourceAvailability {
  const raw = asRecord(value);
  const state = raw?.state;
  const safeState: SourceAvailabilityState =
    state === "available-in-session" || state === "reconnect-needed" || state === "unknown" ? state : "unknown";
  const checkedAt = raw ? text(raw.checkedAt, 80) : undefined;
  return {
    state: safeState,
    ...(checkedAt === undefined ? {} : { checkedAt }),
  };
}

function sanitizeMethod(value: unknown): RecognitionMethod {
  return value === "acoustid" ||
    value === "enhanced-recognition" ||
    value === "development-fixture" ||
    value === "manual" ||
    value === "unknown"
    ? value
    : "unknown";
}

function sanitizeEvidence(value: unknown): RecognitionEvidence | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const lookupSource = text(raw.lookupSource);
  if (!lookupSource) return undefined;
  const confidence = text(raw.confidence, 120);
  const score = number(raw.score);
  const catalogRaw = asRecord(raw.catalogReference);
  const catalogId = catalogRaw && catalogRaw.provider === "musicbrainz" ? text(catalogRaw.id, 120) : undefined;
  return {
    method: sanitizeMethod(raw.method),
    lookupSource,
    sampleRanges: sanitizeTimeRanges(raw.sampleRanges),
    ...(confidence === undefined ? {} : { confidence }),
    ...(score === undefined ? {} : { score }),
    ...(catalogId === undefined ? {} : { catalogReference: { provider: "musicbrainz" as const, id: catalogId } }),
  };
}

function sanitizeOriginalSuggestion(value: unknown): OriginalSuggestion | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const title = text(raw.title);
  const artist = text(raw.artist);
  if (!title || !artist) return undefined;
  const album = text(raw.album);
  const artworkUrl = safeArtworkUrl(raw.artworkUrl);
  return {
    title,
    artist,
    ...(album === undefined ? {} : { album }),
    ...(artworkUrl === undefined ? {} : { artworkUrl }),
  };
}

function safeArtworkUrl(value: unknown): string | undefined {
  const candidate = text(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeCorrections(value: unknown): UserCorrections | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const title = text(raw.title);
  const artist = text(raw.artist);
  const album = text(raw.album);
  const moment = sanitizeMoment(raw.moment);
  const note = text(raw.note, MAX_NOTE_LENGTH);
  if (!title && !artist && !album && !moment && !note) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(artist === undefined ? {} : { artist }),
    ...(album === undefined ? {} : { album }),
    ...(moment === undefined ? {} : { moment }),
    ...(note === undefined ? {} : { note }),
  };
}

function sanitizeState(value: unknown): RecoveryState {
  return value === "suggested" || value === "confirmed" || value === "edited" || value === "manual" || value === "removed" ? value : "suggested";
}

function sanitizeSelection(value: unknown, state: RecoveryState): EntrySelection {
  if (state === "removed") return "not-kept";
  if (value === "kept" || value === "not-kept") return value;
  return state === "confirmed" || state === "edited" || state === "manual" ? "kept" : "not-kept";
}

function sanitizeEntry(value: unknown, index: number, now: string, fallbackPrefix = "entry"): SoundtrackEntry | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const title = text(raw.title);
  if (!title) return undefined;
  const state = sanitizeState(raw.state);
  const id = text(raw.id, 160) ?? stableFallbackId(fallbackPrefix, index);
  const artist = text(raw.artist) ?? "";
  const album = text(raw.album);
  const artworkUrl = safeArtworkUrl(raw.artworkUrl);
  const moment = sanitizeMoment(raw.moment);
  const note = text(raw.note, MAX_NOTE_LENGTH);
  const originalSuggestion = sanitizeOriginalSuggestion(raw.originalSuggestion);
  const corrections = sanitizeCorrections(raw.corrections);
  const evidence = sanitizeEvidence(raw.evidence);
  const createdAt = isoDate(raw.createdAt, now);
  const updatedAt = isoDate(raw.updatedAt, createdAt);

  return {
    id,
    state,
    selection: sanitizeSelection(raw.selection, state),
    title,
    artist,
    createdAt,
    updatedAt,
    ...(album === undefined ? {} : { album }),
    ...(artworkUrl === undefined ? {} : { artworkUrl }),
    ...(moment === undefined ? {} : { moment }),
    ...(note === undefined ? {} : { note }),
    ...(originalSuggestion === undefined ? {} : { originalSuggestion }),
    ...(corrections === undefined ? {} : { corrections }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function sanitizeReceipt(value: unknown, fallback: RecognitionReceipt): RecognitionReceipt {
  const raw = asRecord(value);
  if (!raw) return fallback;
  const outcome: ReceiptOutcome =
    raw.outcome === "matches-found" ||
      raw.outcome === "no-match" ||
      raw.outcome === "partial-failure" ||
      raw.outcome === "pipeline-failed" ||
      raw.outcome === "cancelled"
      ? raw.outcome
      : fallback.outcome;
  const temporaryArtifacts = raw.temporaryArtifacts === "cleaned" || raw.temporaryArtifacts === "not-created" || raw.temporaryArtifacts === "unknown" ? raw.temporaryArtifacts : fallback.temporaryArtifacts;
  const enhancedRaw = asRecord(raw.enhancedRecognition);
  const approval =
    enhancedRaw?.approval === "approved" || enhancedRaw?.approval === "declined" || enhancedRaw?.approval === "not-used" || enhancedRaw?.approval === "unknown"
      ? enhancedRaw.approval
      : fallback.enhancedRecognition.approval;
  const signatureRaw = asRecord(enhancedRaw?.signatureTransfer);
  const hasSignatureTransfer =
    approval === "approved" &&
    signatureRaw?.destination === "unofficial-shazam-compatible" &&
    signatureRaw?.dataType === "recognition-signature";
  const signatureRanges = hasSignatureTransfer ? sanitizeTimeRanges(signatureRaw?.signatureRanges, MAX_SIGNATURE_RANGES) : [];
  const methods = Array.isArray(raw.methods) ? unique(raw.methods.map(sanitizeMethod)).slice(0, 8) : fallback.methods;
  const candidateCount = nonNegativeNumber(raw.candidateCount) ?? fallback.candidateCount;
  const completedAt = isoDate(raw.completedAt, fallback.completedAt);
  const id = text(raw.id, 160) ?? fallback.id;

  return {
    id,
    completedAt,
    selectedRanges: sanitizeTimeRanges(raw.selectedRanges),
    methods,
    outcome,
    candidateCount,
    temporaryArtifacts,
    enhancedRecognition: {
      approval,
      ...(hasSignatureTransfer
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

function receiptForEntries(recordId: string, completedAt: string, entries: SoundtrackEntry[]): RecognitionReceipt {
  const methods = unique(entries.map((entry) => entry.evidence?.method).filter((method): method is RecognitionMethod => Boolean(method)));
  const hasEnhancedRecognition = methods.includes("enhanced-recognition");
  return {
    id: recordId + ":receipt",
    completedAt,
    selectedRanges: [],
    methods: methods.length > 0 ? methods : ["unknown"],
    outcome: entries.length > 0 ? "matches-found" : "no-match",
    candidateCount: entries.length,
    temporaryArtifacts: "unknown",
    enhancedRecognition: {
      approval: hasEnhancedRecognition ? "unknown" : "not-used",
    },
  };
}

/** Build a privacy-safe record from typed app state. Unknown input properties are dropped. */
export function createSoundtrackRecord(input: CreateSoundtrackRecordInput): SoundtrackRecord {
  const now = new Date().toISOString();
  const source = sanitizeSource(input.source) ?? { fileName: "Untitled source" };
  const id = text(input.id, 160) ?? createSoundtrackId("soundtrack");
  const createdAt = isoDate(input.createdAt, now);
  const updatedAt = isoDate(input.updatedAt, createdAt);
  const entries = input.entries
    .map((entry, index) => sanitizeEntry(entry, index, createdAt, id + ":entry"))
    .filter((entry): entry is SoundtrackEntry => Boolean(entry))
    .slice(0, MAX_ENTRIES_PER_RECORD);
  const fallbackReceipt = receiptForEntries(id, updatedAt, entries);

  return {
    schemaVersion: SOUNDTRACK_SCHEMA_VERSION,
    id,
    source,
    sourceAvailability: sanitizeSourceAvailability(input.sourceAvailability),
    entries,
    receipt: sanitizeReceipt(input.receipt, fallbackReceipt),
    ...(input.coverEntryId ? { coverEntryId: text(input.coverEntryId, 160) } : {}),
    createdAt,
    updatedAt,
  };
}

/** A local, non-secret identifier for newly created records. */
export function createSoundtrackId(prefix = "soundtrack"): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return prefix + "-" + (randomId ?? Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
}

/**
 * Whitelist and validate a v2 persisted record. It intentionally returns a
 * fresh object so future runtime-only properties cannot leak into persistence.
 */
export function parseSoundtrackRecord(value: unknown): SoundtrackRecord | null {
  const raw = asRecord(value);
  if (!raw || raw.schemaVersion !== SOUNDTRACK_SCHEMA_VERSION) return null;
  const source = sanitizeSource(raw.source);
  const id = text(raw.id, 160);
  if (!source || !id) return null;
  const now = new Date().toISOString();
  const createdAt = isoDate(raw.createdAt, now);
  const updatedAt = isoDate(raw.updatedAt, createdAt);
  const entries = Array.isArray(raw.entries)
    ? raw.entries
      .map((entry, index) => sanitizeEntry(entry, index, createdAt, id + ":entry"))
      .filter((entry): entry is SoundtrackEntry => Boolean(entry))
      .slice(0, MAX_ENTRIES_PER_RECORD)
    : [];
  const fallbackReceipt = receiptForEntries(id, updatedAt, entries);

  return {
    schemaVersion: SOUNDTRACK_SCHEMA_VERSION,
    id,
    source,
    sourceAvailability: sanitizeSourceAvailability(raw.sourceAvailability),
    entries,
    receipt: sanitizeReceipt(raw.receipt, fallbackReceipt),
    ...(typeof raw.coverEntryId === "string" ? { coverEntryId: text(raw.coverEntryId, 160) } : {}),

    createdAt,
    updatedAt,
  };
}

function legacyMethod(lookupSource: unknown): RecognitionMethod {
  const label = text(lookupSource)?.toLowerCase() ?? "";
  if (label.includes("shazam") || label.includes("enhanced")) return "enhanced-recognition";
  if (label.includes("acoustid") || label.includes("musicbrainz")) return "acoustid";
  if (label.includes("fixture")) return "development-fixture";
  return "unknown";
}

/** The normalized candidate shape currently returned by the Tauri scan command. */
export interface RecognitionCandidateInput {
  id?: string;
  title: string;
  artist?: string;
  album?: string;
  score?: number;
  confidence?: string;
  timestamps?: readonly number[];
  musicbrainzId?: string | null;
  artworkUrl?: string | null;
  lookupSource?: string;
}

export interface CreateRecognitionEntriesOptions {
  /** Used only to produce deterministic fallback entry IDs. */
  recordId?: string;
  selectedIds?: ReadonlySet<string> | readonly string[];
  createdAt?: string;
  method?: RecognitionMethod;
}

/**
 * Adapt normalized recognition candidates into the recoverable soundtrack model.
 * No provider payload is accepted or retained; only the display-ready candidate
 * fields and compact evidence needed to explain the suggestion are copied.
 */
export function createEntriesFromRecognitionCandidates(
  candidates: readonly RecognitionCandidateInput[],
  options: CreateRecognitionEntriesOptions = {},
): SoundtrackEntry[] {
  const createdAt = isoDate(options.createdAt, new Date().toISOString());
  const selectedIds = options.selectedIds instanceof Set ? options.selectedIds : new Set(options.selectedIds ?? []);
  const recordId = text(options.recordId, 160) ?? "recognition";
  const usedIds = new Set<string>();

  return candidates
    .map((candidate, index): SoundtrackEntry | undefined => {
      const title = text(candidate.title);
      if (!title) return undefined;
      const sourceId = text(candidate.id, 160) ?? stableFallbackId(recordId + ":entry", index);
      const id = usedIds.has(sourceId) ? sourceId + "-" + String(index + 1) : sourceId;
      usedIds.add(id);
      const artist = text(candidate.artist) ?? "";
      const album = text(candidate.album);
      const artworkUrl = safeArtworkUrl(candidate.artworkUrl);
      const lookupSource = text(candidate.lookupSource) ?? "Local recognition";
      const score = number(candidate.score);
      const confidence = text(candidate.confidence, 120);
      const musicbrainzId = text(candidate.musicbrainzId, 120);
      const timestamps = (candidate.timestamps ?? []).map(nonNegativeNumber).filter((timestamp): timestamp is number => timestamp !== undefined);
      const moment = timestamps[0] === undefined ? undefined : { startSeconds: timestamps[0], precision: "approximate" as const };
      const sampleRanges = sampleRangesFromTimestamps(timestamps);
      const isSelected = selectedIds.has(sourceId);
      const method = options.method ?? legacyMethod(lookupSource);

      return {
        id,
        state: isSelected ? "confirmed" : "suggested",
        selection: isSelected ? "kept" : "not-kept",
        title,
        artist,
        createdAt,
        updatedAt: createdAt,
        originalSuggestion: {
          title,
          artist,
          ...(album === undefined ? {} : { album }),
          ...(artworkUrl === undefined ? {} : { artworkUrl }),
        },
        evidence: {
          method,
          lookupSource,
          sampleRanges,
          ...(score === undefined ? {} : { score }),
          ...(confidence === undefined ? {} : { confidence }),
          ...(musicbrainzId === undefined ? {} : { catalogReference: { provider: "musicbrainz" as const, id: musicbrainzId } }),
        },
        ...(album === undefined ? {} : { album }),
        ...(artworkUrl === undefined ? {} : { artworkUrl }),
        ...(moment === undefined ? {} : { moment }),
      };
    })
    .filter((entry): entry is SoundtrackEntry => Boolean(entry));
}

function legacyCandidateToEntry(candidateValue: unknown, recordId: string, index: number, acceptedIds: Set<string>, createdAt: string): SoundtrackEntry | undefined {
  const candidate = asRecord(candidateValue) as LegacyCandidate | null;
  if (!candidate) return undefined;
  const title = text(candidate.title);
  if (!title) return undefined;
  const id = text(candidate.id, 160) ?? stableFallbackId(recordId + ":entry", index);
  const artist = text(candidate.artist) ?? "";
  const timestamps = Array.isArray(candidate.timestamps)
    ? candidate.timestamps.map(nonNegativeNumber).filter((timestamp): timestamp is number => timestamp !== undefined)
    : [];
  const moment = timestamps[0] === undefined ? undefined : { startSeconds: timestamps[0], precision: "approximate" as const };
  const sampleRanges = sampleRangesFromTimestamps(timestamps);
  const lookupSource = text(candidate.lookupSource) ?? "Legacy local scan";
  const score = number(candidate.score);
  const confidence = text(candidate.confidence, 120);
  const musicbrainzId = text(candidate.musicbrainzId, 120);
  const artworkUrl = safeArtworkUrl(candidate.artworkUrl);
  const isAccepted = acceptedIds.has(id);
  const method = legacyMethod(lookupSource);
  const evidence: RecognitionEvidence = {
    method,
    lookupSource,
    sampleRanges,
    ...(score === undefined ? {} : { score }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(musicbrainzId === undefined ? {} : { catalogReference: { provider: "musicbrainz", id: musicbrainzId } }),
  };

  return {
    id,
    state: isAccepted ? "confirmed" : "suggested",
    selection: isAccepted ? "kept" : "not-kept",
    title,
    artist,
    originalSuggestion: {
      title,
      artist,
      ...(artworkUrl === undefined ? {} : { artworkUrl }),
    },
    evidence,
    createdAt,
    updatedAt: createdAt,
    ...(artworkUrl === undefined ? {} : { artworkUrl }),
    ...(moment === undefined ? {} : { moment }),
  };
}

function migrateLegacySavedScan(value: unknown, index: number, now: string): SoundtrackRecord | null {
  const scan = asRecord(value) as LegacySavedScan | null;
  if (!scan) return null;
  const source = sanitizeSource(scan.source);
  if (!source) return null;
  const id = text(scan.id, 160) ?? stableFallbackId("legacy-scan", index);
  const createdAt = isoDate(scan.createdAt, now);
  const acceptedIds = new Set(
    Array.isArray(scan.acceptedIds)
      ? scan.acceptedIds.map((acceptedId) => text(acceptedId, 160)).filter((acceptedId): acceptedId is string => Boolean(acceptedId))
      : [],
  );
  const entries = Array.isArray(scan.candidates)
    ? scan.candidates
      .map((candidate, entryIndex) => legacyCandidateToEntry(candidate, id, entryIndex, acceptedIds, createdAt))
      .filter((entry): entry is SoundtrackEntry => Boolean(entry))
      .slice(0, MAX_ENTRIES_PER_RECORD)
    : [];

  return {
    schemaVersion: SOUNDTRACK_SCHEMA_VERSION,
    id,
    source,
    // v1 intentionally did not retain a reopen-safe source reference.
    sourceAvailability: { state: "reconnect-needed" },
    entries,
    receipt: receiptForEntries(id, createdAt, entries),
    createdAt,
    updatedAt: createdAt,
  };
}

export interface HistoryMigrationResult {
  records: SoundtrackRecord[];
  migratedLegacyCount: number;
  invalidCount: number;
}

/**
 * Reads either the current v1 `soniq:scan-history-v1` array or v2 record array.
 * It never spreads source objects or candidates, so legacy `path`-like fields
 * are silently discarded during migration.
 */
export function migrateSoundtrackHistory(value: unknown): HistoryMigrationResult {
  if (!Array.isArray(value)) return { records: [], migratedLegacyCount: 0, invalidCount: 0 };
  const now = new Date().toISOString();
  const records: SoundtrackRecord[] = [];
  let migratedLegacyCount = 0;
  let invalidCount = 0;

  value.slice(0, MAX_RECORDS).forEach((item, index) => {
    const v2 = parseSoundtrackRecord(item);
    if (v2) {
      records.push(v2);
      return;
    }
    const legacy = migrateLegacySavedScan(item, index, now);
    if (legacy) {
      records.push(legacy);
      migratedLegacyCount += 1;
      return;
    }
    invalidCount += 1;
  });

  return { records, migratedLegacyCount, invalidCount };
}

/** Serialize only parser-normalized records for safe local persistence. */
export function serializeSoundtrackHistory(records: readonly SoundtrackRecord[]): string {
  const safeRecords = records
    .slice(0, MAX_RECORDS)
    .map(parseSoundtrackRecord)
    .filter((record): record is SoundtrackRecord => Boolean(record));
  return JSON.stringify(safeRecords);
}

function isCueSheetState(state: RecoveryState): state is CueSheetEntry["state"] {
  return state === "confirmed" || state === "edited" || state === "manual";
}

type ExportableSoundtrackEntry = SoundtrackEntry & { state: CueSheetEntry["state"] };

function isExportableSoundtrackEntry(entry: SoundtrackEntry): entry is ExportableSoundtrackEntry {
  return entry.selection === "kept" && isCueSheetState(entry.state);
}

/**
 * Return the one canonical output order. Input order is intentionally retained
 * as a tie-breaker and as the person-defined order for entries without moments.
 */
export function createCueSheet(entries: readonly SoundtrackEntry[]): CueSheetEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter((item): item is { entry: ExportableSoundtrackEntry; index: number } => isExportableSoundtrackEntry(item.entry))
    .sort((left, right) => {
      const leftTime = left.entry.moment?.startSeconds;
      const rightTime = right.entry.moment?.startSeconds;
      if (leftTime === undefined && rightTime === undefined) return left.index - right.index;
      if (leftTime === undefined) return 1;
      if (rightTime === undefined) return -1;
      return leftTime === rightTime ? left.index - right.index : leftTime - rightTime;
    })
    .map(({ entry }) => ({
      id: entry.id,
      ...(entry.moment === undefined ? {} : { timestampSeconds: entry.moment.startSeconds }),
      title: entry.title,
      artist: entry.artist || DEFAULT_ARTIST,
      ...(entry.album === undefined ? {} : { album: entry.album }),
      state: entry.state,
      origin: entry.state === "manual" ? "manual" : "recognized",
      ...(entry.note === undefined ? {} : { note: entry.note }),
    }));
}

export function formatCueTimestamp(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) {
    return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(remainingSeconds).padStart(2, "0");
  }
  return String(minutes).padStart(2, "0") + ":" + String(remainingSeconds).padStart(2, "0");
}

/** A portable, human-readable cue sheet suitable for the clipboard. */
export function formatCueSheetText(entries: readonly CueSheetEntry[], title = "SonIQ cue sheet"): string {
  const heading = text(title, 160) ?? "SonIQ cue sheet";
  const lines = entries.map((entry) => {
    const credit = entry.title + " — " + entry.artist;
    return entry.timestampSeconds === undefined ? "—  " + credit : formatCueTimestamp(entry.timestampSeconds) + "  " + credit;
  });
  return lines.length > 0 ? heading + "\n\n" + lines.join("\n") : heading + "\n\nNo confirmed tracks yet.";
}

function escapeCsv(value: string | number | undefined): string {
  const stringValue = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(stringValue) ? '"' + stringValue.replace(/"/g, '""') + '"' : stringValue;
}

/** RFC 4180-friendly rows, without private source or recognition payload data. */
export function serializeCueSheetCsv(entries: readonly CueSheetEntry[]): string {
  const header = ["timestamp", "title", "artist", "album", "state", "origin", "note"];
  const rows = entries.map((entry) =>
    [
      entry.timestampSeconds === undefined ? "" : formatCueTimestamp(entry.timestampSeconds),
      entry.title,
      entry.artist,
      entry.album,
      entry.state,
      entry.origin,
      entry.note,
    ]
      .map(escapeCsv)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n") + "\r\n";
}

/** Structured handoff containing only canonical cue-sheet fields. */
export function serializeCueSheetJson(entries: readonly CueSheetEntry[]): string {
  return JSON.stringify(
    {
      format: "soniq-cue-sheet",
      version: 1,
      entries: entries.map((entry) => ({
        ...(entry.timestampSeconds === undefined ? {} : { timestampSeconds: entry.timestampSeconds }),
        title: entry.title,
        artist: entry.artist,
        ...(entry.album === undefined ? {} : { album: entry.album }),
        state: entry.state,
        origin: entry.origin,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      })),
    },
    null,
    2,
  );
}

/** Safe display-based export filename. Source paths are never accepted or emitted. */
export function createCueSheetFilename(sourceName: string | undefined, format: CueSheetFormat): string {
  const base = (sourceName ?? "soniq-cue-sheet")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return (base || "soniq-cue-sheet") + "-cue-sheet." + format;
}
