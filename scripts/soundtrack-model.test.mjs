import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRecognitionIdentity,
  createCueSheet,
  createEntriesFromRecognitionCandidates,
  createSoundtrackRecord,
  migrateSoundtrackHistory,
  serializeCueSheetCsv,
  serializeSoundtrackHistory,
} from "../src/lib/soundtrack.ts";
import { normalizeMomentSelection } from "../src/lib/soundtrack-map.ts";
import { removeSoniqOwnedStorage, soniqOwnedStorageKeys } from "../src/lib/workspace-settings.ts";

test("recognition entries preserve every returned timestamp as compact sample evidence", () => {
  const [entry] = createEntriesFromRecognitionCandidates(
    [
      {
        id: "multi-moment",
        title: "Udi Udi",
        artist: "Aneesh, Sarkar & Hruday",
        timestamps: [0, 16.25, 32],
      },
    ],
    { createdAt: "2026-07-16T00:00:00.000Z" },
  );

  assert.deepEqual(entry.evidence?.sampleRanges, [
    { startSeconds: 0, endSeconds: 8 },
    { startSeconds: 16.25, endSeconds: 24.25 },
    { startSeconds: 32, endSeconds: 40 },
  ]);
  assert.equal(entry.moment?.startSeconds, 0);
});

test("canonical recognition identity normalizes case and punctuation without pair collisions", () => {
  assert.equal(
    canonicalRecognitionIdentity("  Udi Udi — Remastered! ", "ANEESH, Sarkar & Hruday"),
    canonicalRecognitionIdentity("udi udi remastered", "aneesh sarkar hruday"),
  );
  assert.notEqual(canonicalRecognitionIdentity("A, B", "C"), canonicalRecognitionIdentity("A", "B, C"));
});

test("enhanced signature ranges are whitelisted, bounded, and retain no transfer data", () => {
  const signatureRanges = Array.from({ length: 14 }, (_, index) => ({ startSeconds: index * 8, endSeconds: index * 8 + 8 }));
  const record = createSoundtrackRecord({
    id: "enhanced-receipt",
    source: { fileName: "clip.mov" },
    entries: [],
    receipt: {
      id: "enhanced-receipt:receipt",
      completedAt: "2026-07-16T00:00:00.000Z",
      selectedRanges: [],
      methods: ["enhanced-recognition"],
      outcome: "no-match",
      candidateCount: 0,
      temporaryArtifacts: "cleaned",
      enhancedRecognition: {
        approval: "approved",
        signatureTransfer: {
          destination: "unofficial-shazam-compatible",
          dataType: "recognition-signature",
          sourceVideoTransferred: true,
          rawPcmTransferred: true,
          retainedBySonIQ: true,
          signatureRanges,
          providerPayload: "must never persist",
        },
      },
    },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });

  assert.equal(record.receipt.enhancedRecognition.signatureTransfer?.signatureRanges?.length, 12);
  assert.deepEqual(record.receipt.enhancedRecognition.signatureTransfer?.signatureRanges?.[0], { startSeconds: 0, endSeconds: 8 });
  assert.equal(record.receipt.enhancedRecognition.signatureTransfer?.sourceVideoTransferred, false);
  assert.equal(record.receipt.enhancedRecognition.signatureTransfer?.rawPcmTransferred, false);
  assert.equal(record.receipt.enhancedRecognition.signatureTransfer?.retainedBySonIQ, false);

  const serialized = serializeSoundtrackHistory([record]);
  assert.equal(serialized.includes("providerPayload"), false);
  assert.equal(serialized.includes("must never persist"), false);
  assert.match(serialized, /signatureRanges/);
});

test("cue sheet keeps confirmed, corrected, and manual tracks in moment order", () => {
  const [suggestion] = createEntriesFromRecognitionCandidates([
    { id: "suggestion", title: "Suggestion", artist: "Artist", timestamps: [48], lookupSource: "AcoustID / MusicBrainz" },
  ], { createdAt: "2026-07-16T00:00:00.000Z" });

  const entries = [
    suggestion,
    {
      ...suggestion,
      id: "corrected",
      state: "edited",
      selection: "kept",
      title: "Corrected, Title",
      artist: "The Editor",
      moment: { startSeconds: 12, precision: "user-assigned" },
      corrections: { title: "Corrected, Title", artist: "The Editor" },
    },
    {
      id: "manual",
      state: "manual",
      selection: "kept",
      title: "Added by hand",
      artist: "A person",
      moment: { startSeconds: 30, precision: "user-assigned" },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
  ];

  const cueSheet = createCueSheet(entries);
  assert.deepEqual(cueSheet.map((entry) => entry.title), ["Corrected, Title", "Added by hand"]);
  assert.deepEqual(cueSheet.map((entry) => entry.state), ["edited", "manual"]);
  assert.match(serializeCueSheetCsv(cueSheet), /"Corrected, Title"/);
});

test("history migration removes media paths and unknown recognition payloads", () => {
  const migrated = migrateSoundtrackHistory([
    {
      id: "legacy",
      source: { fileName: "/Users/someone/Movies/private-source.mov", durationSeconds: 42, durationLabel: "00:42", path: "/Users/someone/Movies/private-source.mov" },
      createdAt: "2026-07-16T00:00:00.000Z",
      candidates: [
        {
          id: "legacy-track",
          title: "Saved song",
          artist: "Saved artist",
          timestamps: [9],
          lookupSource: "AcoustID / MusicBrainz",
          requestPayload: "must never persist",
        },
      ],
      acceptedIds: ["legacy-track"],
    },
  ]);

  assert.equal(migrated.records.length, 1);
  assert.equal(migrated.records[0].source.fileName, "private-source.mov");
  const stored = serializeSoundtrackHistory(migrated.records);
  assert.equal(stored.includes("/Users/someone"), false);
  assert.equal(stored.includes("requestPayload"), false);
  assert.equal(stored.includes("must never persist"), false);
});

test("runtime preview data cannot survive soundtrack record serialization", () => {
  const [entry] = createEntriesFromRecognitionCandidates([
    { id: "preview-track", title: "Preview title", artist: "Preview artist", timestamps: [8] },
  ], { createdAt: "2026-07-16T00:00:00.000Z" });
  const runtimeOnlyEntry = {
    ...entry,
    previewUrl: "https://audio.example.test/preview.m4a",
    trackViewUrl: "https://music.example.test/track",
    providerPayload: { private: "must never persist" },
  };
  const record = createSoundtrackRecord({
    id: "preview-record",
    source: { fileName: "clip.mov" },
    entries: [runtimeOnlyEntry],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });

  const serialized = serializeSoundtrackHistory([record]);
  assert.equal(serialized.includes("audio.example.test"), false);
  assert.equal(serialized.includes("music.example.test"), false);
  assert.equal(serialized.includes("providerPayload"), false);
  assert.equal(serialized.includes("must never persist"), false);
});

test("runtime soundtrack-map data cannot survive soundtrack record serialization", () => {
  const record = createSoundtrackRecord({
    id: "map-record",
    source: { fileName: "clip.mov", durationSeconds: 64, durationLabel: "01:04" },
    entries: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  const runtimeOnlyRecord = {
    ...record,
    soundtrackMap: {
      available: true,
      activityRegions: [{ startSeconds: 8, endSeconds: 16, activityLevel: 0.74 }],
      recommendedRanges: [{ startSeconds: 8, endSeconds: 16 }],
      rawPcm: "must never persist",
    },
    providerPayload: "must never persist",
  };

  const serialized = serializeSoundtrackHistory([runtimeOnlyRecord]);
  assert.equal(serialized.includes("soundtrackMap"), false);
  assert.equal(serialized.includes("activityRegions"), false);
  assert.equal(serialized.includes("rawPcm"), false);
  assert.equal(serialized.includes("providerPayload"), false);
  assert.equal(serialized.includes("must never persist"), false);
});

test("map selections become a valid bounded Moment Finder range", () => {
  assert.deepEqual(
    normalizeMomentSelection({ startSeconds: 30, endSeconds: 34 }, 60),
    { startSeconds: 28, endSeconds: 36 },
  );
  assert.deepEqual(
    normalizeMomentSelection({ startSeconds: 0, endSeconds: 40 }, 60),
    { startSeconds: 6, endSeconds: 34 },
  );
  assert.equal(normalizeMomentSelection({ startSeconds: 0, endSeconds: 4 }, 6), null);
});

test("SonIQ reset removes only its explicitly owned local keys", () => {
  const removed = [];
  removeSoniqOwnedStorage({ removeItem: (key) => removed.push(key) });

  assert.deepEqual(removed, [...soniqOwnedStorageKeys]);
  assert.equal(removed.includes("unrelated:browser-preference"), false);
});

test("record serialization retains manual and corrected state without raw media data", () => {
  const record = createSoundtrackRecord({
    id: "record",
    source: { fileName: "clip.mov", durationSeconds: 90, durationLabel: "01:30" },
    sourceAvailability: { state: "reconnect-needed" },
    entries: [
      {
        id: "manual",
        state: "manual",
        selection: "kept",
        title: "A manual correction",
        artist: "Dawn",
        note: "Recognised by the editor",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        sourcePath: "/Users/dawn/Movies/clip.mov",
        fingerprint: "not allowed",
      },
    ],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });

  const stored = serializeSoundtrackHistory([record]);
  assert.match(stored, /"manual"/);
  assert.match(stored, /Recognised by the editor/);
  assert.equal(stored.includes("sourcePath"), false);
  assert.equal(stored.includes("fingerprint"), false);
  assert.equal(stored.includes("/Users/dawn"), false);
});
