import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { developmentFixture } from "./lib/fixture";
import type { TargetedRange } from "./lib/soundtrack-map";
import {
  createCueSheet,
  createCueSheetFilename,
  createEntriesFromRecognitionCandidates,
  canonicalRecognitionIdentity,
  createSoundtrackRecord,
  formatCueSheetText,
  serializeCueSheetCsv,
  serializeCueSheetJson,
  type SoundtrackEntry,
  type SoundtrackRecord,
} from "./lib/soundtrack";
import { getAuthData, getSpotifyAuthUrl, exchangeCodeForToken, clearAuthData } from "./lib/spotify-auth";
import { exportSoundtrack } from "./lib/spotify-api";
import { exportToYouTube } from "./lib/youtube-api";
import {
  fixtureCandidates,
  getInitialOnboarding,
  getInitialScreen,
  getInitialThemePreference,
  getSystemTheme,
  isSupportedVideo,
  maxSavedScans,
  mergeTimeRanges,
  nameKey,
  onboardingKey,
  plannedEnhancedTargetedRanges,
  previewScreens,
  readLocal,
  readSoundtrackRecords,
  receiptForResult,
  recordForResult,
  removeLocal,
  resetSoniqOwnedStorage,
  themeKey,
  writeLocal,
  persistSoundtrackRecords,
  libraryStore,
} from "./features/workspace/utils";
import type {
  ActiveSoundtrackMap,
  AppScreen,
  AppView,
  EntryEdits,
  LocalScanResult,
  ScanProgress,
  SourceVideo,
  Theme,
  ThemePreference,
  VideoInfo,
  WaveformEnvelope,
} from "./features/workspace/types";
import { AppSidebar, WorkspaceToolbar } from "./features/shell/AppShell";
import { Onboarding } from "./features/onboarding/Onboarding";
import { IntakeCanvas, PendingCanvas, ScanningCanvas } from "./features/scan/ScanCanvases";
import { RecoveryReviewCanvas } from "./features/soundtrack/RecoveryReviewCanvas";
import { MomentFinderCanvas } from "./features/moments/MomentFinderCanvas";
import { PlaylistExport } from "./features/export/PlaylistExport";
import { SoundtrackLibraryCanvas } from "./features/library/SoundtrackLibraryCanvas";
import { SettingsCanvas } from "./features/settings/SettingsCanvas";

export default function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [screen, setScreen] = useState<AppScreen>(getInitialScreen);
  const [activeView, setActiveView] = useState<AppView>("scan");
  const [themePreference, setThemePreference] = useState<ThemePreference>(getInitialThemePreference);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const [displayName, setDisplayName] = useState(() => readLocal(nameKey) ?? "");
  const [showOnboarding, setShowOnboarding] = useState(getInitialOnboarding);
  const [libraryViewMode, setLibraryViewMode] = useState<"list" | "grid">("list");
  const [dragActive, setDragActive] = useState(false);
  const [validationMessage, setValidationMessage] = useState("");
  const [scanNotice, setScanNotice] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [records, setRecords] = useState<SoundtrackRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [previewRecord, setPreviewRecord] = useState<SoundtrackRecord | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [enhancedRecognition, setEnhancedRecognition] = useState(true);
  const [spotifyAuthLoading, setSpotifyAuthLoading] = useState(false);
  const [isSpotifyConnected, setIsSpotifyConnected] = useState(false);
  const [spotifyExportState, setSpotifyExportState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [spotifyExportError, setSpotifyExportError] = useState<string | null>(null);
  const [exportPlatform, setExportPlatform] = useState<"spotify" | "youtube">("youtube");
  const [youtubeExportState, setYoutubeExportState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [youtubeExportError, setYoutubeExportError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceVideo | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("preview");
    return requested && previewScreens.includes(requested as AppScreen) && requested !== "import"
      ? { ...developmentFixture.source, isFixture: true }
      : null;
  });
  // Map evidence is intentionally confined to the active source session. It is
  // never copied into records, receipts, exports, or local history.
  const [activeSoundtrackMap, setActiveSoundtrackMap] = useState<ActiveSoundtrackMap | null>(null);
  const [pendingMomentRange, setPendingMomentRange] = useState<TargetedRange | null>(null);
  const [waveform, setWaveform] = useState<WaveformEnvelope | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [copyState, setCopyState] = useState<"" | "copied" | "unavailable">("");
  const [exportState, setExportState] = useState<"" | "csv" | "json" | "unavailable">("");
  const [deletedRecord, setDeletedRecord] = useState<SoundtrackRecord | null>(null);
  const activeJobRef = useRef(0);
  const skipNextHistoryPersistRef = useRef(false);
  const removedEntrySnapshotsRef = useRef(new Map<string, Pick<SoundtrackEntry, "state" | "selection">>());
  const actionRef = useRef<{
    acceptVideoPath: (path: string) => Promise<void>;
    chooseVideo: () => Promise<void>;
    openLibrary: () => void;
    copyCueSheet: () => Promise<void>;
    cancelScan: () => Promise<void>;
  }>({
    acceptVideoPath: async () => { },
    chooseVideo: async () => { },
    openLibrary: () => { },
    copyCueSheet: async () => { },
    cancelScan: async () => { },
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const handleAuthCode = (code: string) => {
      setSpotifyAuthLoading(true);
      exchangeCodeForToken(code)
        .then(() => {
          setSpotifyAuthLoading(false);
          setIsSpotifyConnected(true);
        })
        .catch((err) => {
          console.error("Spotify auth failed:", err);
          setSpotifyAuthLoading(false);
        });
    };

    onOpenUrl((urls) => {
      const url = urls[0];
      if (url && url.startsWith("soniq://callback")) {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("code");
        if (code) handleAuthCode(code);
      }
    }).then(u => { unlisten = u; });

    const parsedParams = new URLSearchParams(window.location.search);
    const code = parsedParams.get("code");
    if (code) {
      window.history.replaceState({}, document.title, window.location.pathname);
      handleAuthCode(code);
    }

    getAuthData().then((data) => {
      if (data) setIsSpotifyConnected(true);
    }).catch(() => { /* not connected or expired */ });

    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleSpotifyConnect = async () => {
    try {
      setSpotifyAuthLoading(true);
      const { url } = await getSpotifyAuthUrl();
      await openUrl(url);
    } catch (err) {
      console.error(err);
      setSpotifyAuthLoading(false);
    }
  };

  const handleSpotifyDisconnect = async () => {
    await clearAuthData();
    setIsSpotifyConnected(false);
  };

  const handleSpotifyExport = async (record: SoundtrackRecord) => {
    try {
      setSpotifyExportState("loading");
      const name = `SonIQ Playlist (${new Date().toLocaleDateString()})`;
      const entries = record.entries.filter(e => e.selection === "kept");
      await exportSoundtrack(name, entries);
      setSpotifyExportState("success");
      setTimeout(() => setSpotifyExportState("idle"), 3000);
    } catch (err: any) {
      console.error(err);
      const errorMsg = err.message || String(err);
      setSpotifyExportError(errorMsg);
      setSpotifyExportState("error");

      if (isTauri()) {
        await message(errorMsg, { title: 'Spotify Export Failed', kind: 'error' });
      }

      setTimeout(() => setSpotifyExportState("idle"), 5000);
    }
  };

  const handleYouTubeExport = async (record: SoundtrackRecord) => {
    try {
      setYoutubeExportState("loading");
      const entries = record.entries.filter(e => e.selection === "kept");
      const url = await exportToYouTube(entries);
      setYoutubeExportState("success");
      await openUrl(url);
      setTimeout(() => setYoutubeExportState("idle"), 3000); // Reset after 3 seconds
    } catch (err: any) {
      console.error(err);
      const errorMsg = err.message || String(err);
      setYoutubeExportError(errorMsg);
      setYoutubeExportState("error");

      if (isTauri()) {
        await message(errorMsg, { title: 'YouTube Export Failed', kind: 'error' });
      } else {
        window.alert("YouTube Export Failed: " + errorMsg);
      }
      setTimeout(() => setYoutubeExportState("idle"), 5000);
    }
  };

  const activeRecord = useMemo(
    () => previewRecord ?? records.find((record) => record.id === activeRecordId) ?? null,
    [activeRecordId, previewRecord, records],
  );
  const activeRuntimeMap = activeSoundtrackMap && activeRecord?.id === activeSoundtrackMap.recordId ? activeSoundtrackMap.map : undefined;
  const theme = themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    readSoundtrackRecords().then((loaded) => {
      if (disposed) return;
      setRecords(loaded);
      setRecordsLoaded(true);
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!source?.isFixture || previewRecord || !["review", "moments", "handoff"].includes(screen)) return;
    const record = recordForResult(
      {
        source: { fileName: source.fileName, durationSeconds: source.durationSeconds ?? 136, durationLabel: source.duration },
        candidates: fixtureCandidates,
        recognitionStatus: "complete",
        message: "Fixture-only candidates for development.",
      },
      false,
    );
    setPreviewRecord(record);
    setReviewMessage("Fixture-only candidates for development.");
  }, [previewRecord, screen, source]);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;

    const updateSystemTheme = () => setSystemTheme(mediaQuery.matches ? "dark" : "light");
    updateSystemTheme();
    mediaQuery.addEventListener?.("change", updateSystemTheme);
    return () => mediaQuery.removeEventListener?.("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    if (!recordsLoaded) return;
    if (skipNextHistoryPersistRef.current) {
      skipNextHistoryPersistRef.current = false;
      return;
    }
    void persistSoundtrackRecords(records);
  }, [records, recordsLoaded]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragActive(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragActive(false);
          return;
        }
        setDragActive(false);
        const path = event.payload.paths[0];
        if (path) void actionRef.current.acceptVideoPath(path);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<ScanProgress>("scan-progress", (event) => setScanProgress(event.payload)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (screen !== "moments" || !source?.path || !activeRecord || !isTauri()) {
      setWaveform(null);
      setWaveformLoading(false);
      return;
    }

    let disposed = false;
    setWaveformLoading(true);
    void invoke<WaveformEnvelope>("generate_waveform_envelope", { sourcePath: source.path })
      .then((result) => {
        if (!disposed) setWaveform(result);
      })
      .catch(() => {
        if (!disposed) setWaveform(null);
      })
      .finally(() => {
        if (!disposed) setWaveformLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [activeRecord?.id, screen, source?.path]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editingText = target?.matches("input, textarea, select, [contenteditable='true']");
      if (editingText) return;
      const command = event.metaKey || event.ctrlKey;

      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void actionRef.current.chooseVideo();
      } else if (command && event.key.toLowerCase() === "l") {
        event.preventDefault();
        actionRef.current.openLibrary();
      } else if (command && event.shiftKey && event.key.toLowerCase() === "c" && screen === "handoff") {
        event.preventDefault();
        void actionRef.current.copyCueSheet();
      } else if (event.key === "Escape" && screen === "moments") {
        event.preventDefault();
        if (isTauri()) void invoke<boolean>("cancel_active_waveform").catch(() => undefined);
        setPendingMomentRange(null);
        setScreen("review");
      } else if (event.key === "Escape" && screen === "scanning") {
        event.preventDefault();
        void actionRef.current.cancelScan();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screen]);

  useEffect(() => {
    if (showOnboarding) return;
    const animationFrame = window.requestAnimationFrame(() => document.getElementById("screen-title")?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeView, screen, showOnboarding]);

  function updateRecords(update: (current: SoundtrackRecord[]) => SoundtrackRecord[]) {
    setRecords((current) => update(current).slice(0, maxSavedScans));
  }

  function updateActiveRecord(update: (record: SoundtrackRecord) => SoundtrackRecord) {
    if (previewRecord) {
      setPreviewRecord((record) => record ? update(record) : record);
      return;
    }
    if (!activeRecordId) return;
    updateRecords((current) => current.map((record) => record.id === activeRecordId ? update(record) : record));
  }

  function invalidateActiveWork() {
    activeJobRef.current += 1;
    if (!isTauri()) return;
    void invoke<boolean>("cancel_active_scan").catch(() => undefined);
    void invoke<boolean>("cancel_active_waveform").catch(() => undefined);
  }

  function completeScan(result: LocalScanResult, targetedRange?: TargetedRange) {
    const finishedAt = new Date().toISOString();
    setReviewMessage(result.message);
    setScanProgress(null);

    if (targetedRange && activeRecordId) {
      const targetEntries = createEntriesFromRecognitionCandidates(result.candidates, {
        recordId: activeRecordId,
        createdAt: finishedAt,
      });
      const targetReceipt = receiptForResult(result, enhancedRecognition, targetedRange);

      updateActiveRecord((record) => {
        const existingByIdentity = new Map(
          record.entries.map((entry) => [canonicalRecognitionIdentity(entry.title, entry.artist), entry]),
        );
        const entries = [...record.entries];

        for (const candidate of targetEntries) {
          const identity = canonicalRecognitionIdentity(candidate.title, candidate.artist);
          const existing = existingByIdentity.get(identity);
          if (!existing) {
            entries.push(candidate);
            existingByIdentity.set(identity, candidate);
            continue;
          }
          const safeRanges = mergeTimeRanges(existing.evidence?.sampleRanges ?? [], candidate.evidence?.sampleRanges ?? []);
          const position = entries.findIndex((entry) => entry.id === existing.id);
          const shouldUseEarlierDetectedMoment = Boolean(
            candidate.moment && (!existing.moment || (existing.moment.precision === "approximate" && candidate.moment.startSeconds < existing.moment.startSeconds)),
          );
          const updated = {
            ...existing,
            evidence: existing.evidence
              ? { ...existing.evidence, sampleRanges: safeRanges }
              : candidate.evidence,
            ...(shouldUseEarlierDetectedMoment ? { moment: candidate.moment } : {}),
            updatedAt: finishedAt,
          };
          entries[position] = updated;
          existingByIdentity.set(identity, updated);
        }

        const signatureTemplate = targetReceipt.enhancedRecognition.signatureTransfer ?? record.receipt.enhancedRecognition.signatureTransfer;
        const signatureRanges = mergeTimeRanges(
          record.receipt.enhancedRecognition.signatureTransfer?.signatureRanges ?? [],
          targetReceipt.enhancedRecognition.signatureTransfer?.signatureRanges ?? [],
        );
        const signatureTransfer = signatureTemplate
          ? { ...signatureTemplate, ...(signatureRanges.length ? { signatureRanges } : {}) }
          : undefined;
        const methods = Array.from(new Set([...record.receipt.methods, ...targetReceipt.methods]));
        const selectedRanges = mergeTimeRanges(record.receipt.selectedRanges, targetReceipt.selectedRanges);
        entries.sort((left, right) => (left.moment?.startSeconds ?? Number.POSITIVE_INFINITY) - (right.moment?.startSeconds ?? Number.POSITIVE_INFINITY));
        return createSoundtrackRecord({
          ...record,
          entries,
          sourceAvailability: { state: "available-in-session", checkedAt: finishedAt },
          receipt: {
            ...targetReceipt,
            id: record.receipt.id,
            completedAt: finishedAt,
            candidateCount: entries.filter((entry) => entry.state !== "removed").length,
            methods,
            selectedRanges,
            enhancedRecognition: {
              approval: enhancedRecognition ? "approved" : record.receipt.enhancedRecognition.approval,
              ...(signatureTransfer ? { signatureTransfer } : {}),
            },
          },
          updatedAt: finishedAt,
        });
      });
      setPendingMomentRange(null);
      setScreen("review");
      return;
    }

    const record = recordForResult(result, enhancedRecognition);
    if (source?.isFixture) {
      setActiveSoundtrackMap(null);
      setPendingMomentRange(null);
      setPreviewRecord(record);
      setActiveRecordId(null);
      setScreen("review");
      return;
    }
    if (source?.bookmark) {
      libraryStore.set("soniq:source-bookmark:" + record.id, source.bookmark)
        .then(() => libraryStore.save())
        .catch(() => undefined);
    }
    setActiveSoundtrackMap(result.soundtrackMap ? { recordId: record.id, map: result.soundtrackMap } : null);
    setPendingMomentRange(null);
    updateRecords((current) => [record, ...current.filter((item) => item.id !== record.id)]);
    setActiveRecordId(record.id);
    setScreen("review");
  }

  async function chooseVideo() {
    setValidationMessage("");
    if (!isTauri()) {
      fileInput.current?.click();
      return;
    }

    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }],
      });
      if (typeof selected === "string") await acceptVideoPath(selected);
    } catch {
      setValidationMessage("SonIQ could not open the video picker. Try dropping a video onto the window instead.");
    }
  }

  async function acceptVideoPath(path: string) {
    invalidateActiveWork();
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    try {
      const info = await invoke<VideoInfo>("inspect_video", { sourcePath: path });
      setValidationMessage("");
      setScanNotice("");
      setReviewMessage("");
      setScanProgress(null);
      setActiveRecordId(null);
      setPreviewRecord(null);
      setEnhancedRecognition(true);
      setDragActive(false);
      setWaveform(null);
      let bookmark: string | undefined = undefined;
      if (isTauri()) bookmark = await invoke<string>("create_bookmark", { path }).catch(() => undefined);
      setSource({ fileName: info.fileName, duration: info.durationLabel, durationSeconds: info.durationSeconds, path, bookmark });
      setActiveView("scan");
      setScreen("pending");
      if (showOnboarding) persistOnboarding();
    } catch (error) {
      setDragActive(false);
      setValidationMessage(typeof error === "string" ? error : "SonIQ could not inspect that video. Choose another file.");
    }
  }

  async function reconnectSource() {
    invalidateActiveWork();
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    if (!activeRecordId || !isTauri()) {
      void chooseVideo();
      return;
    }
    try {
      const selected = await open({ multiple: false, directory: false, filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }] });
      if (typeof selected !== "string") return;
      const info = await invoke<VideoInfo>("inspect_video", { sourcePath: selected });
      const checkedAt = new Date().toISOString();
      const bookmark = await invoke<string>("create_bookmark", { path: selected }).catch(() => undefined);
      setSource({ fileName: info.fileName, duration: info.durationLabel, durationSeconds: info.durationSeconds, path: selected, bookmark });
      if (bookmark) {
        await libraryStore.set("soniq:source-bookmark:" + activeRecordId, bookmark);
        await libraryStore.save();
      }
      updateActiveRecord((record) => createSoundtrackRecord({
        ...record,
        source: info,
        sourceAvailability: { state: "available-in-session", checkedAt },
        updatedAt: checkedAt,
      }));
      setScanNotice("");
      setScreen("review");
      setActiveView("scan");
    } catch {
      setScanNotice("SonIQ could not reconnect that source. You can still view and export the saved playlist.");
    }
  }

  function acceptFile(file: File) {
    if (!isSupportedVideo(file)) {
      setValidationMessage("Choose an MP4, MOV, or M4V video to continue.");
      return;
    }

    setValidationMessage("");
    setDragActive(false);
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setEnhancedRecognition(true);
    setActiveRecordId(null);
    setPreviewRecord(null);
    setScanNotice("Real scanning is available in the SonIQ desktop app. Launch it with npm run tauri dev.");
    setSource({ fileName: file.name, duration: "Browser preview only" });
    setActiveView("scan");
    setScreen("pending");
    if (showOnboarding) persistOnboarding();
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (isTauri()) return;
    const file = event.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  }

  async function startScan() {
    if (source?.isFixture) {
      setScreen("scanning");
      return;
    }
    if (!source?.path || !isTauri()) {
      setScanNotice("Start the desktop app to run a local media scan.");
      return;
    }

    setScanNotice("");
    setReviewMessage("");
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setScanProgress({ stage: "Mapping local activity", detail: "Finding distinct acoustic activity on this Mac.", completedSamples: 0, totalSamples: 1 });
    setScreen("scanning");
    const requestId = ++activeJobRef.current;

    try {
      const result = await invoke<LocalScanResult>("run_local_scan", { sourcePath: source.path, enhancedRecognition });
      if (requestId !== activeJobRef.current) return;
      completeScan(result);
    } catch (error) {
      if (requestId !== activeJobRef.current) return;
      setScanNotice(typeof error === "string" ? error : "SonIQ could not finish this local scan. Choose another video or try again.");
      setScreen("pending");
    }
  }

  function completeFixtureScan() {
    if (!source) return;
    completeScan({
      source: { fileName: source.fileName, durationSeconds: source.durationSeconds ?? 136, durationLabel: source.duration },
      candidates: fixtureCandidates,
      recognitionStatus: "complete",
      message: "Fixture-only candidates for development.",
    });
  }

  async function runTargetedRecovery(range: TargetedRange) {
    if (!source?.path || !isTauri()) {
      setScanNotice("Reconnect a local source before trying another moment.");
      return;
    }
    setScanNotice("");
    const enhancedChecks = enhancedRecognition ? plannedEnhancedTargetedRanges(range).length : 0;
    setScanProgress({
      stage: "Preparing selected moment",
      detail: "Checking only the range you chose.",
      completedSamples: 0,
      totalSamples: 1 + enhancedChecks,
    });
    const requestId = ++activeJobRef.current;
    try {
      const result = await invoke<LocalScanResult>("run_targeted_recovery", {
        sourcePath: source.path,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        enhancedRecognition,
      });
      if (requestId !== activeJobRef.current) return;
      completeScan(result, range);
    } catch (error) {
      if (requestId !== activeJobRef.current) return;
      setScanNotice(typeof error === "string" ? error : "SonIQ could not recover this moment. Adjust the range, add a track manually, or choose another video.");
      setScanProgress(null);
      setScreen("moments");
    }
  }

  async function cancelScan() {
    try {
      await invoke<boolean>("cancel_active_scan");
      setScanProgress((current) => current ? { ...current, stage: "Cancelling local scan", detail: "Removing temporary audio samples now." } : current);
    } catch {
      setScanNotice("SonIQ could not cancel the scan. It will stop as soon as the current local step finishes.");
    }
  }

  function startNewScan() {
    invalidateActiveWork();
    removedEntrySnapshotsRef.current.clear();
    setValidationMessage("");
    setScanNotice("");
    setReviewMessage("");
    setScanProgress(null);
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setActiveRecordId(null);
    setPreviewRecord(null);
    setEnhancedRecognition(true);
    setCopyState("");
    setExportState("");
    setWaveform(null);
    setSource(null);
    setScreen("import");
    setActiveView("scan");
  }

  async function openRecord(record: SoundtrackRecord) {
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setPreviewRecord(null);

    let resolvedPath: string | undefined = undefined;
    let resolvedBookmark: string | undefined = undefined;
    if (activeRecordId === record.id && source?.path) {
      resolvedPath = source.path;
      resolvedBookmark = source.bookmark;
    } else if (isTauri()) {
      const savedBookmark = (await libraryStore.get<string>("soniq:source-bookmark:" + record.id)) ?? undefined;
      let pathToInspect = readLocal("soniq:source-path:" + record.id) ?? undefined;

      if (savedBookmark) {
        try {
          pathToInspect = await invoke<string>("resolve_bookmark", { bookmarkBase64: savedBookmark });
        } catch {
          // Bookmark is not available anymore
        }
      }

      if (pathToInspect) {
        try {
          const info = await invoke<VideoInfo>("inspect_video", { sourcePath: pathToInspect });
          resolvedPath = pathToInspect;
          resolvedBookmark = savedBookmark;

          if (!savedBookmark) {
            const newBookmark = await invoke<string>("create_bookmark", { path: pathToInspect }).catch(() => undefined);
            if (newBookmark) {
              await libraryStore.set("soniq:source-bookmark:" + record.id, newBookmark);
              await libraryStore.save();
              resolvedBookmark = newBookmark;
            }
          }

          if (record.sourceAvailability.state !== "available-in-session") {
            updateRecords((current) => current.map(item => item.id === record.id ? createSoundtrackRecord({
              ...item,
              sourceAvailability: { state: "available-in-session", checkedAt: new Date().toISOString() },
              updatedAt: new Date().toISOString()
            }) : item));
          }
        } catch {
          // File missing or unreadable
        }
      }
    }

    if (resolvedPath) {
      setSource({
        fileName: record.source.fileName,
        duration: record.source.durationLabel ?? "Saved source",
        durationSeconds: record.source.durationSeconds,
        path: resolvedPath,
        bookmark: resolvedBookmark
      });
    } else {
      setSource({
        fileName: record.source.fileName,
        duration: record.source.durationLabel ?? "Saved source",
        durationSeconds: record.source.durationSeconds,
      });
      if (record.sourceAvailability.state !== "reconnect-needed") {
        updateRecords((current) => current.map(item => item.id === record.id ? createSoundtrackRecord({
          ...item,
          sourceAvailability: { state: "reconnect-needed", checkedAt: new Date().toISOString() },
          updatedAt: new Date().toISOString()
        }) : item));
      }
    }

    setActiveRecordId(record.id);
    setReviewMessage(record.entries.length ? "Saved on this Mac. You can continue correcting or exporting this soundtrack." : "No track was saved yet. Add one manually or reconnect the source to try a moment.");
    setScanNotice("");
    setScanProgress(null);
    setActiveView("scan");
    setScreen("review");
  }

  function openLibrary() {
    invalidateActiveWork();
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setDeletedRecord(null);
    setActiveView("library");
  }

  function toggleEntryKept(entryId: string) {
    updateActiveRecord((record) => createSoundtrackRecord({
      ...record,
      entries: record.entries.map((entry) => {
        if (entry.id !== entryId || entry.state === "removed") return entry;
        const keeping = entry.selection !== "kept";
        return {
          ...entry,
          selection: keeping ? "kept" : "not-kept",
          state: keeping && entry.state === "suggested" ? "confirmed" : !keeping && entry.state === "confirmed" ? "suggested" : entry.state,
          updatedAt: new Date().toISOString(),
        };
      }),
      updatedAt: new Date().toISOString(),
    }));
  }

  function editEntry(entryId: string, edits: EntryEdits) {
    updateActiveRecord((record) => createSoundtrackRecord({
      ...record,
      entries: record.entries.map((entry) => {
        if (entry.id !== entryId) return entry;
        const now = new Date().toISOString();
        const hasMoment = typeof edits.momentSeconds === "number" && Number.isFinite(edits.momentSeconds) && edits.momentSeconds >= 0;
        const moment = edits.momentSeconds === null ? undefined : hasMoment ? { startSeconds: edits.momentSeconds!, precision: "user-assigned" as const } : entry.moment;
        const originalSuggestion = entry.originalSuggestion ?? { title: entry.title, artist: entry.artist, ...(entry.album ? { album: entry.album } : {}), ...(entry.artworkUrl ? { artworkUrl: entry.artworkUrl } : {}) };
        return {
          ...entry,
          title: edits.title,
          artist: edits.artist,
          ...(edits.album ? { album: edits.album } : {}),
          ...(edits.album ? {} : { album: undefined }),
          ...(edits.note ? { note: edits.note } : {}),
          ...(edits.note ? {} : { note: undefined }),
          ...(moment ? { moment } : { moment: undefined }),
          state: entry.state === "manual" ? "manual" : "edited",
          selection: "kept",
          originalSuggestion,
          corrections: {
            title: edits.title,
            artist: edits.artist,
            ...(edits.album ? { album: edits.album } : {}),
            ...(edits.note ? { note: edits.note } : {}),
            ...(moment ? { moment } : {}),
          },
          updatedAt: now,
        };
      }),
      updatedAt: new Date().toISOString(),
    }));
  }

  function removeEntry(entryId: string) {
    updateActiveRecord((record) => createSoundtrackRecord({
      ...record,
      entries: record.entries.map((entry) => {
        if (entry.id !== entryId) return entry;
        removedEntrySnapshotsRef.current.set(entry.id, { state: entry.state, selection: entry.selection });
        return { ...entry, state: "removed", selection: "not-kept", updatedAt: new Date().toISOString() };
      }),
      updatedAt: new Date().toISOString(),
    }));
  }

  function undoRemoveEntry(entryId: string) {
    updateActiveRecord((record) => createSoundtrackRecord({
      ...record,
      entries: record.entries.map((entry) => {
        if (entry.id !== entryId) return entry;
        const snapshot = removedEntrySnapshotsRef.current.get(entry.id);
        removedEntrySnapshotsRef.current.delete(entry.id);
        const restoredState = snapshot?.state ?? (entry.evidence ? entry.corrections ? "edited" : "suggested" : "manual");
        const restoredSelection = snapshot?.selection ?? (restoredState === "manual" ? "kept" : "not-kept");
        return { ...entry, state: restoredState, selection: restoredSelection, updatedAt: new Date().toISOString() };
      }),
      updatedAt: new Date().toISOString(),
    }));
  }

  function addManualEntry(entry: SoundtrackEntry) {
    updateActiveRecord((record) => createSoundtrackRecord({
      ...record,
      entries: [...record.entries, entry],
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteRecord(record: SoundtrackRecord) {
    updateRecords((current) => current.filter((item) => item.id !== record.id));
    removeLocal("soniq:source-path:" + record.id);
    libraryStore.delete("soniq:source-bookmark:" + record.id)
      .then(() => libraryStore.save())
      .catch(() => undefined);
    setDeletedRecord(record);
    if (activeRecordId === record.id) {
      setActiveRecordId(null);
      setActiveSoundtrackMap(null);
      setPendingMomentRange(null);
    }
  }

  function renameRecord(record: SoundtrackRecord, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === record.source.fileName) return;
    updateRecords((current) => current.map((item) => {
      if (item.id !== record.id) return item;
      return {
        ...item,
        source: { ...item.source, fileName: trimmed },
        updatedAt: new Date().toISOString()
      };
    }));
  }

  function setRecordCover(record: SoundtrackRecord, coverEntryId: string) {
    updateRecords((current) => current.map((item) => {
      if (item.id !== record.id) return item;
      return {
        ...item,
        coverEntryId,
        updatedAt: new Date().toISOString()
      };
    }));
  }

  function undoDeleteRecord() {
    if (!deletedRecord) return;
    updateRecords((current) => [deletedRecord, ...current.filter((record) => record.id !== deletedRecord.id)]);
    setDeletedRecord(null);
  }

  function saveDisplayName(nextName: string) {
    const cleanedName = nextName.trim();
    setDisplayName(cleanedName);
    if (cleanedName) writeLocal(nameKey, cleanedName);
    else removeLocal(nameKey);
  }

  function setAppearance(nextTheme: ThemePreference) {
    setThemePreference(nextTheme);
    if (nextTheme === "system") removeLocal(themeKey);
    else writeLocal(themeKey, nextTheme);
  }

  function persistOnboarding() {
    writeLocal(onboardingKey, "true");
    if (displayName.trim()) writeLocal(nameKey, displayName.trim());
    else removeLocal(nameKey);
    if (themePreference === "system") removeLocal(themeKey);
    else writeLocal(themeKey, themePreference);
    setShowOnboarding(false);
  }

  function completeOnboarding() {
    persistOnboarding();
    setScreen("import");
    setActiveView("scan");
  }

  function openSettings() {
    setActiveView("settings");
  }

  function returnToWorkspace() {
    setActiveView("scan");
  }

  function openMomentFinder(range?: TargetedRange) {
    setPendingMomentRange(range ?? null);
    setScreen("moments");
  }

  function resetSoniq() {
    // Explicit reset is the only path that intentionally cancels active work.
    invalidateActiveWork();
    skipNextHistoryPersistRef.current = true;
    void resetSoniqOwnedStorage();
    removedEntrySnapshotsRef.current.clear();
    setRecords([]);
    setPreviewRecord(null);
    setActiveRecordId(null);
    setDeletedRecord(null);
    setSource(null);
    setActiveSoundtrackMap(null);
    setPendingMomentRange(null);
    setWaveform(null);
    setWaveformLoading(false);
    setValidationMessage("");
    setScanNotice("");
    setReviewMessage("");
    setScanProgress(null);
    setEnhancedRecognition(true);
    setCopyState("");
    setExportState("");
    setDisplayName("");
    setThemePreference("system");
    setSystemTheme(getSystemTheme());
    setScreen("import");
    setActiveView("scan");
    setShowOnboarding(true);
  }

  async function copyCueSheet() {
    if (!activeRecord) return;
    const cueSheet = createCueSheet(activeRecord.entries);
    try {
      await navigator.clipboard.writeText(formatCueSheetText(cueSheet, activeRecord.source.fileName + " · SonIQ playlist"));
      setCopyState("copied");
      window.setTimeout(() => setCopyState(""), 1800);
    } catch {
      setCopyState("unavailable");
    }
  }

  async function exportCueSheet(format: "csv" | "json") {
    if (!activeRecord) return;
    const cueSheet = createCueSheet(activeRecord.entries);
    const content = format === "csv" ? serializeCueSheetCsv(cueSheet) : serializeCueSheetJson(cueSheet);
    try {
      if (!isTauri()) {
        const blob = new Blob([content], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" });
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(blob);
        anchor.download = createCueSheetFilename(activeRecord.source.fileName, format);
        anchor.click();
        URL.revokeObjectURL(anchor.href);
      } else {
        const destinationPath = await save({
          defaultPath: createCueSheetFilename(activeRecord.source.fileName, format),
          filters: [{ name: format === "csv" ? "CSV" : "JSON", extensions: [format] }],
        });
        if (!destinationPath) return;
        await invoke("save_cue_sheet", { destinationPath, content });
      }
      setExportState(format);
      window.setTimeout(() => setExportState(""), 1800);
    } catch {
      setExportState("unavailable");
    }
  }

  async function openSpotifySearch(entry: { title: string; artist: string }) {
    const url = "https://open.spotify.com/search/" + encodeURIComponent(entry.title + " " + entry.artist);
    try {
      if (isTauri()) await openUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setExportState("unavailable");
    }
  }

  function leaveMomentFinder() {
    if (isTauri()) void invoke<boolean>("cancel_active_waveform").catch(() => undefined);
    setPendingMomentRange(null);
    setScreen("review");
  }

  actionRef.current = { acceptVideoPath, chooseVideo, openLibrary, copyCueSheet, cancelScan };

  const visibleSource = source ?? (activeRecord ? {
    fileName: activeRecord.source.fileName,
    duration: activeRecord.source.durationLabel ?? "Saved source",
    durationSeconds: activeRecord.source.durationSeconds,
  } : null);
  const sourceAvailable = Boolean(source?.path && activeRecord?.sourceAvailability.state === "available-in-session");
  const toolbarContext = activeView === "settings" ? "Settings" : activeView === "library" ? "Library" : screen === "moments" ? "Moment Finder" : screen === "handoff" ? "Playlist" : screen === "review" ? "Playlist review" : "New scan";

  return (
    <>
      <input ref={fileInput} className="sr-only" type="file" accept="video/mp4,video/quicktime,video/x-m4v,video/*,.mp4,.mov,.m4v" onChange={onFileChange} />
      {showOnboarding ? <Onboarding name={displayName} theme={theme} onNameChange={setDisplayName} onThemeChange={setAppearance} onComplete={completeOnboarding} /> : (
        <div className="app-shell" data-theme={theme}>
          <AppSidebar activeView={activeView} onNewScan={startNewScan} onLibrary={openLibrary} onSettings={openSettings} />
          <main className="app-workspace-container">
            <div className="app-workspace">
              <WorkspaceToolbar activeView={activeView} context={toolbarContext} theme={theme} viewMode={libraryViewMode} onToggleTheme={() => setAppearance(theme === "light" ? "dark" : "light")} onToggleViewMode={setLibraryViewMode} />
              <div className="workspace-canvas">
                {activeView === "settings" && <SettingsCanvas displayName={displayName} themePreference={themePreference} resolvedTheme={theme} onSaveName={saveDisplayName} onSaveAppearance={setAppearance} onBackToWorkspace={returnToWorkspace} onReset={resetSoniq} isSpotifyConnected={isSpotifyConnected} spotifyAuthLoading={spotifyAuthLoading} onSpotifyConnect={handleSpotifyConnect} onSpotifyDisconnect={handleSpotifyDisconnect} exportPlatform={exportPlatform} onExportPlatformChange={setExportPlatform} />}
                {activeView === "library" && <SoundtrackLibraryCanvas records={records} viewMode={libraryViewMode} onNewScan={startNewScan} onOpen={openRecord} onDelete={deleteRecord} onRename={renameRecord} onSetCover={setRecordCover} deletedRecord={deletedRecord} onUndoDelete={undoDeleteRecord} />}
                {activeView === "scan" && screen === "import" && <IntakeCanvas displayName={displayName} onSelect={chooseVideo} onDrop={onDrop} dragActive={dragActive} onDragChange={setDragActive} validationMessage={validationMessage} />}
                {activeView === "scan" && screen === "pending" && source && <PendingCanvas source={source} notice={scanNotice} enhancedRecognition={enhancedRecognition} onBack={startNewScan} onEnhancedRecognitionChange={setEnhancedRecognition} onStart={startScan} />}
                {activeView === "scan" && screen === "scanning" && source && <ScanningCanvas source={source} progress={scanProgress} enhancedRecognition={enhancedRecognition} onCancel={cancelScan} onNext={completeFixtureScan} />}
                {activeView === "scan" && screen === "review" && activeRecord && visibleSource && <RecoveryReviewCanvas source={visibleSource} record={activeRecord} map={activeRuntimeMap} message={reviewMessage || "No reliable matches were returned for this scan."} sourceAvailable={sourceAvailable} onToggleKept={toggleEntryKept} onEdit={editEntry} onRemove={removeEntry} onUndoRemove={undoRemoveEntry} onAddManual={addManualEntry} onOpenMomentFinder={openMomentFinder} onReconnect={reconnectSource} onContinue={() => setScreen("handoff")} onNewScan={startNewScan} isSpotifyConnected={isSpotifyConnected} spotifyAuthLoading={spotifyAuthLoading} spotifyExportState={spotifyExportState} spotifyExportError={spotifyExportError} onSpotifyConnect={handleSpotifyConnect} onSpotifyExport={() => handleSpotifyExport(activeRecord)} exportPlatform={exportPlatform} youtubeExportState={youtubeExportState} youtubeExportError={youtubeExportError} onYouTubeExport={() => handleYouTubeExport(activeRecord)} />}
                {activeView === "scan" && screen === "moments" && activeRecord && visibleSource && <MomentFinderCanvas source={visibleSource} record={activeRecord} waveform={waveform} waveformLoading={waveformLoading} enhancedRecognition={enhancedRecognition} initialRange={pendingMomentRange} onEnhancedRecognitionChange={setEnhancedRecognition} onStartTargetedRecovery={runTargetedRecovery} onCancelRecovery={() => { void cancelScan(); }} notice={scanNotice} onBack={leaveMomentFinder} />}
                {activeView === "scan" && screen === "handoff" && activeRecord && <PlaylistExport record={activeRecord} copyState={copyState} exportState={exportState} onCopy={copyCueSheet} onExport={exportCueSheet} onOpenSpotify={openSpotifySearch} onBack={() => setScreen("review")} onRestart={startNewScan} isSpotifyConnected={isSpotifyConnected} spotifyAuthLoading={spotifyAuthLoading} spotifyExportState={spotifyExportState} spotifyExportError={spotifyExportError} onSpotifyConnect={handleSpotifyConnect} onSpotifyExport={() => handleSpotifyExport(activeRecord)} exportPlatform={exportPlatform} youtubeExportState={youtubeExportState} youtubeExportError={youtubeExportError} onYouTubeExport={() => handleYouTubeExport(activeRecord)} />}
              </div>
            </div>
          </main>
        </div>
      )}
    </>
  );
}
