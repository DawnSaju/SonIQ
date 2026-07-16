use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const TARGET_SAMPLE_SECONDS: f64 = 28.0;
const MIN_WINDOW_SECONDS: f64 = 8.0;
const ENHANCED_SAMPLE_SECONDS: f64 = 8.0;
const MAX_ENHANCED_DISCOVERY_SIGNATURES: usize = 6;
const MAX_ENHANCED_TARGETED_SIGNATURES: usize = 4;
const TARGETED_RECOVERY_MIN_SECONDS: f64 = MIN_WINDOW_SECONDS;
const TARGETED_RECOVERY_MAX_SECONDS: f64 = TARGET_SAMPLE_SECONDS;
const MAX_WAVEFORM_DURATION_SECONDS: f64 = 30.0 * 60.0;
const WAVEFORM_SAMPLE_RATE: u32 = 8_000;
const WAVEFORM_BUCKETS_PER_SECOND: f64 = 4.0;
const MAX_WAVEFORM_BUCKETS: usize = 360;
const ACOUSTIC_MAP_SAMPLE_RATE: u32 = 2_000;
const ACOUSTIC_MAP_BUCKETS_PER_SECOND: f64 = 4.0;
const MAX_ACOUSTIC_MAP_BUCKETS: usize = 7_200;
const MAX_ACOUSTIC_ACTIVITY_REGIONS: usize = 12;
const MIN_ACOUSTIC_ACTIVITY_REGION_SECONDS: f64 = 3.0;
const MAX_ACOUSTIC_ACTIVITY_GAP_SECONDS: f64 = 0.75;
const MIN_ACOUSTIC_ACTIVITY_LEVEL: f32 = 0.008;
const MIN_ACOUSTIC_ACTIVITY_CONTRAST: f32 = 0.012;
const ENHANCED_WINDOW_START_EPSILON_SECONDS: f64 = 0.25;
const MAX_CUE_SHEET_BYTES: usize = 1_024 * 1_024;
const ENHANCED_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
const PREVIEW_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_PREVIEW_DISPLAY_TEXT_LENGTH: usize = 500;
const LOOKUP_PACING: Duration = Duration::from_millis(350);
const ENHANCED_LOOKUP_PACING: Duration = Duration::from_millis(750);
const CANCELLATION_MESSAGE: &str = "Scan cancelled. Your source video was not changed.";

#[derive(Default)]
struct ScanController {
    approved_source: Mutex<Option<PathBuf>>,
    active_cancellation: Mutex<Option<Arc<AtomicBool>>>,
    active_waveform_cancellation: Mutex<Option<Arc<AtomicBool>>>,
}

impl ScanController {
    fn approve(&self, source: PathBuf) {
        if let Ok(mut approved) = self.approved_source.lock() {
            *approved = Some(source);
        }
    }

    fn start(&self, source: &Path) -> Result<Arc<AtomicBool>, String> {
        let approved = self
            .approved_source
            .lock()
            .map_err(|_| "SonIQ could not access the selected source.".to_string())?
            .clone();

        if approved.as_deref() != Some(source) {
            return Err("Choose the video again before starting a scan.".to_string());
        }

        let mut active = self
            .active_cancellation
            .lock()
            .map_err(|_| "SonIQ could not start the scan.".to_string())?;

        if active.is_some() {
            return Err("A local scan is already in progress.".to_string());
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancellation));
        Ok(cancellation)
    }

    fn cancel(&self) -> bool {
        let mut cancelled = false;
        if let Ok(active) = self.active_cancellation.lock() {
            if let Some(cancellation) = active.as_ref() {
                cancellation.store(true, Ordering::SeqCst);
                cancelled = true;
            }
        }
        cancelled
    }

    fn clear(&self, completed: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active_cancellation.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, completed))
            {
                *active = None;
            }
        }
    }

    fn start_waveform(&self, source: &Path) -> Result<Arc<AtomicBool>, String> {
        let approved = self
            .approved_source
            .lock()
            .map_err(|_| "SonIQ could not access the selected source.".to_string())?
            .clone();

        if approved.as_deref() != Some(source) {
            return Err("Choose the video again before creating its local moment map.".to_string());
        }

        let mut active = self
            .active_waveform_cancellation
            .lock()
            .map_err(|_| "SonIQ could not start the local waveform task.".to_string())?;

        if let Some(previous) = active.as_ref() {
            previous.store(true, Ordering::SeqCst);
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancellation));
        Ok(cancellation)
    }

    fn cancel_waveform(&self) -> bool {
        if let Ok(active) = self.active_waveform_cancellation.lock() {
            if let Some(cancellation) = active.as_ref() {
                cancellation.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    fn clear_waveform(&self, completed: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active_waveform_cancellation.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, completed))
            {
                *active = None;
            }
        }
    }
}

#[derive(Clone)]
struct InspectedSource {
    canonical_path: PathBuf,
    file_name: String,
    duration_seconds: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    file_name: String,
    duration_seconds: f64,
    duration_label: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    stage: String,
    detail: String,
    completed_samples: usize,
    total_samples: usize,
}

#[derive(Debug, PartialEq, Clone)]
struct SampleWindow {
    start_seconds: f64,
    duration_seconds: f64,
}

#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start_seconds: f64,
    end_seconds: f64,
}

/**
 * Compact, session-only evidence from the local activity pass. It contains no
 * waveform values, PCM, source path, fingerprint, signature, or provider data.
 */
#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SoundtrackMap {
    available: bool,
    activity_regions: Vec<AcousticActivityRegion>,
    recommended_ranges: Vec<TimeRange>,
}

#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AcousticActivityRegion {
    start_seconds: f64,
    end_seconds: f64,
    activity_level: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanSample {
    index: usize,
    timestamp_seconds: f64,
    duration_seconds: f64,
    status: String,
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CandidateTrack {
    id: String,
    title: String,
    artist: String,
    score: f64,
    confidence: String,
    timestamps: Vec<f64>,
    musicbrainz_id: Option<String>,
    artwork_url: Option<String>,
    lookup_source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    source: VideoInfo,
    samples: Vec<ScanSample>,
    candidates: Vec<CandidateTrack>,
    recognition_status: String,
    message: String,
    enhanced_recognition_attempted: bool,
    enhanced_signature_submitted: bool,
    enhanced_signature_ranges: Vec<TimeRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    soundtrack_map: Option<SoundtrackMap>,
    temporary_artifacts: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformEnvelope {
    source: VideoInfo,
    start_seconds: f64,
    end_seconds: f64,
    bucket_duration_seconds: f64,
    amplitudes: Vec<f32>,
}

#[derive(Deserialize)]
struct FpcalcOutput {
    duration: f64,
    fingerprint: String,
}

#[derive(Deserialize)]
struct AcoustIdResponse {
    status: String,
    results: Option<Vec<AcoustIdResult>>,
}

#[derive(Deserialize)]
struct AcoustIdResult {
    score: f64,
    recordings: Option<Vec<AcoustIdRecording>>,
}

#[derive(Deserialize)]
struct AcoustIdRecording {
    id: Option<String>,
    title: Option<String>,
    artists: Option<Vec<AcoustIdArtist>>,
}

#[derive(Deserialize)]
struct AcoustIdArtist {
    name: Option<String>,
}

#[derive(Deserialize)]
struct EnhancedRecognitionResponse {
    title: Option<String>,
    artist: Option<String>,
    #[serde(rename = "artworkUrl")]
    artwork_url: Option<String>,
}

struct EnhancedRecognitionOutcome {
    candidate: Option<CandidateTrack>,
    signature_submitted: bool,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItunesSearchResponse {
    results: Option<Vec<ItunesSearchResult>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItunesSearchResult {
    track_name: Option<String>,
    artist_name: Option<String>,
    preview_url: Option<String>,
    track_view_url: Option<String>,
}

/**
 * Runtime-only promotional preview data. It deliberately has no path into a
 * CandidateTrack, ScanResult, or the persisted soundtrack model.
 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackPreview {
    preview_url: Option<String>,
    track_view_url: Option<String>,
    attribution: &'static str,
}

#[tauri::command]
fn inspect_video(
    scan_controller: State<'_, ScanController>,
    source_path: String,
) -> Result<VideoInfo, String> {
    let source = inspect_source(&source_path)?;
    scan_controller.approve(source.canonical_path.clone());
    Ok(video_info(&source))
}

#[tauri::command]
async fn run_local_scan(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let source = inspect_source(&source_path)?;
    let cancellation = scan_controller.start(&source.canonical_path)?;
    let worker_cancellation = Arc::clone(&cancellation);
    let worker_app = app.clone();

    let result = match tauri::async_runtime::spawn_blocking(move || {
        scan_source(
            &worker_app,
            source,
            worker_cancellation,
            enhanced_recognition,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("The local scan task stopped unexpectedly.".to_string()),
    };

    scan_controller.clear(&cancellation);
    result
}

#[tauri::command]
async fn generate_waveform_envelope(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<WaveformEnvelope, String> {
    let source = inspect_source(&source_path)?;
    let window = validate_waveform_range(&source, start_seconds, end_seconds)?;
    let cancellation = scan_controller.start_waveform(&source.canonical_path)?;
    let worker_cancellation = Arc::clone(&cancellation);
    let worker_app = app.clone();

    let result = match tauri::async_runtime::spawn_blocking(move || {
        generate_waveform_envelope_for_range(&worker_app, source, window, worker_cancellation)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("SonIQ could not finish the local waveform task.".to_string()),
    };

    scan_controller.clear_waveform(&cancellation);
    result
}

#[tauri::command]
async fn run_targeted_recovery(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    start_seconds: f64,
    end_seconds: f64,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let source = inspect_source(&source_path)?;
    let window = validate_targeted_recovery_range(&source, start_seconds, end_seconds)?;
    let cancellation = scan_controller.start(&source.canonical_path)?;
    let worker_cancellation = Arc::clone(&cancellation);
    let worker_app = app.clone();

    let result = match tauri::async_runtime::spawn_blocking(move || {
        emit_progress(
            &worker_app,
            "Preparing targeted recovery",
            &format!(
                "Preparing the selected {} to {} moment on this Mac.",
                format_duration(window.start_seconds),
                format_duration(window.start_seconds + window.duration_seconds)
            ),
            0,
            1,
        );
        scan_targeted_recovery(
            &worker_app,
            source,
            window,
            worker_cancellation,
            enhanced_recognition,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("The targeted recovery task stopped unexpectedly.".to_string()),
    };

    scan_controller.clear(&cancellation);
    result
}

/**
 * Resolve an explicitly requested, stream-only promotional preview. The
 * renderer calls this only after a person activates a recognised track's art;
 * no source media, local path, fingerprint, or recognition signature enters
 * this request.
 */
#[tauri::command]
async fn lookup_track_preview(title: String, artist: String) -> Result<TrackPreview, String> {
    let title = validate_preview_display_text(&title, "track title")?;
    let artist = validate_preview_display_text(&artist, "artist")?;

    match tauri::async_runtime::spawn_blocking(move || lookup_itunes_track_preview(&title, &artist))
        .await
    {
        Ok(preview) => Ok(preview),
        Err(_) => Ok(no_track_preview()),
    }
}

#[tauri::command]
fn cancel_active_scan(scan_controller: State<'_, ScanController>) -> bool {
    scan_controller.cancel()
}

#[tauri::command]
fn cancel_active_waveform(scan_controller: State<'_, ScanController>) -> bool {
    scan_controller.cancel_waveform()
}

#[tauri::command]
fn save_cue_sheet(destination_path: String, content: String) -> Result<(), String> {
    let destination = validate_cue_sheet_destination(&destination_path, &content)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                "A file already exists at that location. Choose a new file name to keep the existing export safe."
                    .to_string()
            }
            std::io::ErrorKind::NotFound => {
                "The selected export folder is no longer available. Choose another location.".to_string()
            }
            std::io::ErrorKind::PermissionDenied => {
                "SonIQ does not have permission to save in that folder. Choose another location."
                    .to_string()
            }
            _ => "SonIQ could not create that cue-sheet file. Choose another location.".to_string(),
        })?;

    file.write_all(content.as_bytes()).map_err(|_| {
        let _ = fs::remove_file(&destination);
        "SonIQ could not finish writing that cue-sheet file. No partial export was kept."
            .to_string()
    })?;
    file.sync_all().map_err(|_| {
        let _ = fs::remove_file(&destination);
        "SonIQ could not finish saving that cue-sheet file. No partial export was kept.".to_string()
    })
}

fn inspect_source(source_path: &str) -> Result<InspectedSource, String> {
    let requested_path = PathBuf::from(source_path);
    let canonical_path = requested_path.canonicalize().map_err(|_| {
        "SonIQ could not read that video. Check that it still exists and try again.".to_string()
    })?;

    if !canonical_path.is_file() {
        return Err("Choose an MP4, MOV, or M4V video file—not a folder.".to_string());
    }

    fs::File::open(&canonical_path).map_err(|_| {
        "SonIQ does not have permission to read that video. Choose another file.".to_string()
    })?;

    let extension = canonical_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if !matches!(extension.as_str(), "mp4" | "mov" | "m4v") {
        return Err("Choose an MP4, MOV, or M4V video to continue.".to_string());
    }

    let duration_seconds = probe_duration(&canonical_path)?;
    let file_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Selected video")
        .to_string();

    Ok(InspectedSource {
        canonical_path,
        file_name,
        duration_seconds,
    })
}

fn video_info(source: &InspectedSource) -> VideoInfo {
    VideoInfo {
        file_name: source.file_name.clone(),
        duration_seconds: source.duration_seconds,
        duration_label: format_duration(source.duration_seconds),
    }
}

fn validate_waveform_range(
    source: &InspectedSource,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<SampleWindow, String> {
    match (start_seconds, end_seconds) {
        (None, None) if source.duration_seconds <= MAX_WAVEFORM_DURATION_SECONDS => Ok(SampleWindow {
            start_seconds: 0.0,
            duration_seconds: source.duration_seconds,
        }),
        (None, None) => Err(format!(
            "This video is too long to map at once. Choose a timeline range no longer than {} minutes.",
            (MAX_WAVEFORM_DURATION_SECONDS / 60.0) as u64
        )),
        (Some(start_seconds), Some(end_seconds)) => {
            let range = validate_source_range(source, start_seconds, end_seconds, "waveform")?;
            if range.duration_seconds > MAX_WAVEFORM_DURATION_SECONDS {
                return Err(format!(
                    "Choose a waveform range no longer than {} minutes.",
                    (MAX_WAVEFORM_DURATION_SECONDS / 60.0) as u64
                ));
            }
            Ok(range)
        }
        _ => Err("Choose both the start and end of the waveform range.".to_string()),
    }
}

fn validate_targeted_recovery_range(
    source: &InspectedSource,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<SampleWindow, String> {
    let range = validate_source_range(source, start_seconds, end_seconds, "targeted recovery")?;

    if range.duration_seconds < TARGETED_RECOVERY_MIN_SECONDS {
        return Err(format!(
            "Choose at least {} seconds for a targeted recovery.",
            TARGETED_RECOVERY_MIN_SECONDS as u64
        ));
    }
    if range.duration_seconds > TARGETED_RECOVERY_MAX_SECONDS {
        return Err(format!(
            "Choose no more than {} seconds for a targeted recovery.",
            TARGETED_RECOVERY_MAX_SECONDS as u64
        ));
    }

    Ok(range)
}

fn validate_source_range(
    source: &InspectedSource,
    start_seconds: f64,
    end_seconds: f64,
    label: &str,
) -> Result<SampleWindow, String> {
    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err(format!("Choose a valid {label} range."));
    }
    if start_seconds < 0.0 || end_seconds <= start_seconds {
        return Err(format!("Choose a valid {label} range within this video."));
    }
    if end_seconds > source.duration_seconds + 0.001 {
        return Err(format!(
            "The selected {label} range extends past the end of this video. Adjust it and try again."
        ));
    }

    Ok(SampleWindow {
        start_seconds,
        duration_seconds: (end_seconds.min(source.duration_seconds) - start_seconds).max(0.0),
    })
}

fn validate_cue_sheet_destination(
    destination_path: &str,
    content: &str,
) -> Result<PathBuf, String> {
    if destination_path.trim().is_empty() {
        return Err("Choose a location for the cue-sheet export.".to_string());
    }
    if content.len() > MAX_CUE_SHEET_BYTES {
        return Err("That cue-sheet export is too large to save safely.".to_string());
    }

    let destination = PathBuf::from(destination_path);
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Choose a file name for the cue-sheet export.".to_string())?;
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if !matches!(extension.as_str(), "csv" | "json") {
        return Err("Save the cue sheet as a .csv or .json file.".to_string());
    }

    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "Choose a folder for the cue-sheet export.".to_string())?;
    if !parent.is_dir() {
        return Err(
            "The selected export folder is no longer available. Choose another location."
                .to_string(),
        );
    }

    Ok(destination)
}

fn scan_source(
    app: &AppHandle,
    source: InspectedSource,
    cancellation: Arc<AtomicBool>,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let windows = plan_sample_windows(source.duration_seconds);
    ensure_not_cancelled(&cancellation)?;

    if windows.is_empty() {
        return Err("SonIQ could not find a usable duration in that video.".to_string());
    }

    let ffmpeg = binary_path("ffmpeg")?;
    let fpcalc = binary_path("fpcalc")?;
    let work_dir = temporary_scan_directory()?;
    let scan_result = (|| {
        let mut soundtrack_map =
            match derive_local_soundtrack_map(app, &source, &ffmpeg, &work_dir, &cancellation) {
                Ok(map) => map,
                Err(error) if error == CANCELLATION_MESSAGE => return Err(error),
                Err(_) => SoundtrackMap {
                    available: false,
                    activity_regions: Vec::new(),
                    recommended_ranges: Vec::new(),
                },
            };
        ensure_not_cancelled(&cancellation)?;

        let enhanced_windows = plan_enhanced_discovery_windows_for_map(
            source.duration_seconds,
            &soundtrack_map.activity_regions,
        );
        soundtrack_map.recommended_ranges = enhanced_windows
            .iter()
            .map(time_range_for_enhanced_window)
            .collect();

        scan_source_in_directory(
            app,
            &source,
            &windows,
            &enhanced_windows,
            Some(soundtrack_map),
            &ffmpeg,
            &fpcalc,
            &work_dir,
            &cancellation,
            enhanced_recognition,
        )
    })();

    finish_temporary_work(scan_result, &work_dir, "scan files")
}

fn scan_source_with_windows(
    app: &AppHandle,
    source: InspectedSource,
    windows: Vec<SampleWindow>,
    enhanced_windows: Vec<SampleWindow>,
    cancellation: Arc<AtomicBool>,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    ensure_not_cancelled(&cancellation)?;

    if windows.is_empty() {
        return Err("SonIQ could not find a usable duration in that video.".to_string());
    }

    let ffmpeg = binary_path("ffmpeg")?;
    let fpcalc = binary_path("fpcalc")?;
    let work_dir = temporary_scan_directory()?;

    let scan_result = scan_source_in_directory(
        app,
        &source,
        &windows,
        &enhanced_windows,
        None,
        &ffmpeg,
        &fpcalc,
        &work_dir,
        &cancellation,
        enhanced_recognition,
    );
    finish_temporary_work(scan_result, &work_dir, "scan files")
}

fn scan_targeted_recovery(
    app: &AppHandle,
    source: InspectedSource,
    window: SampleWindow,
    cancellation: Arc<AtomicBool>,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let enhanced_windows = plan_enhanced_targeted_windows(&window);
    let mut result = scan_source_with_windows(
        app,
        source,
        vec![window],
        enhanced_windows,
        cancellation,
        enhanced_recognition,
    )?;

    if result.candidates.is_empty() {
        result.message = match result.recognition_status.as_str() {
            "pipelineFailed" => {
                "SonIQ could not create a usable local sample for this moment. Choose a different moment or add the track manually.".to_string()
            }
            "notConfigured" => {
                "This moment was prepared locally, but standard fingerprint recognition is not configured. Enable it, try enhanced recognition, or add the track manually.".to_string()
            }
            "partialFailure" => {
                "Targeted recovery could not complete every recognition check. Try this moment again, choose a different moment, or add the track manually.".to_string()
            }
            _ => {
                let checked = result.enhanced_signature_ranges.len();
                if checked > 1 {
                    format!(
                        "No reliable match was returned from {checked} short checks within this selected range. Try another moment, add the track manually, or finish an intentionally empty soundtrack."
                    )
                } else {
                    "No reliable match was returned for this selected moment. Try a different moment, add the track manually, or finish an intentionally empty soundtrack.".to_string()
                }
            }
        };
    }

    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn scan_source_in_directory(
    app: &AppHandle,
    source: &InspectedSource,
    windows: &[SampleWindow],
    enhanced_windows: &[SampleWindow],
    soundtrack_map: Option<SoundtrackMap>,
    ffmpeg: &Path,
    fpcalc: &Path,
    work_dir: &Path,
    cancellation: &Arc<AtomicBool>,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let api_key = env::var("SONIQ_ACOUSTID_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty());
    let lookup_client = api_key
        .as_ref()
        .map(|_| {
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(12))
                .build()
                .map_err(|_| "SonIQ could not prepare the recognition client.".to_string())
        })
        .transpose()?;

    let standard_sample_count = windows.len();
    let enhanced_check_count = if enhanced_recognition {
        enhanced_windows.len()
    } else {
        0
    };
    let total_steps = standard_sample_count + enhanced_check_count;
    let mut samples = Vec::with_capacity(standard_sample_count);
    let mut candidates = Vec::new();
    let mut lookup_failed = false;
    let mut enhanced_attempted = false;
    let mut enhanced_signature_submitted = false;
    let mut enhanced_signature_ranges = Vec::with_capacity(enhanced_check_count);
    let mut enhanced_failed = false;
    let mut enhanced_consecutive_failures = 0_usize;

    emit_progress(
        app,
        "Preparing local scan",
        "Planning bounded audio samples on this Mac.",
        0,
        total_steps,
    );

    for (position, window) in windows.iter().enumerate() {
        ensure_not_cancelled(cancellation)?;
        let sample_number = position + 1;
        let audio_path = work_dir.join(format!("sample-{sample_number}.wav"));

        emit_progress(
            app,
            "Extracting local audio",
            &format!("Listening at {}.", format_duration(window.start_seconds)),
            position,
            total_steps,
        );

        if let Err(error) = extract_audio_sample(
            ffmpeg,
            &source.canonical_path,
            window,
            &audio_path,
            cancellation,
        ) {
            if error == CANCELLATION_MESSAGE {
                return Err(error);
            }
            samples.push(ScanSample {
                index: sample_number,
                timestamp_seconds: window.start_seconds,
                duration_seconds: window.duration_seconds,
                status: "failed".to_string(),
                message: Some(error),
            });
            continue;
        }

        emit_progress(
            app,
            "Creating a local fingerprint",
            &format!("Fingerprinting local sample {sample_number} of {standard_sample_count}."),
            position,
            total_steps,
        );

        let fingerprint = match create_fingerprint(fpcalc, &audio_path, cancellation) {
            Ok(fingerprint) => fingerprint,
            Err(error) if error == CANCELLATION_MESSAGE => return Err(error),
            Err(error) => {
                samples.push(ScanSample {
                    index: sample_number,
                    timestamp_seconds: window.start_seconds,
                    duration_seconds: window.duration_seconds,
                    status: "failed".to_string(),
                    message: Some(error),
                });
                continue;
            }
        };

        let mut sample_message = if api_key.is_some() {
            "Fingerprint created locally.".to_string()
        } else {
            "Fingerprint created locally. Recognition is not configured yet.".to_string()
        };

        if let (Some(key), Some(client)) = (api_key.as_deref(), lookup_client.as_ref()) {
            emit_progress(
                app,
                "Checking music fingerprints",
                &format!("Checking local sample {sample_number} of {standard_sample_count}."),
                position,
                total_steps,
            );

            if position > 0 {
                thread::sleep(LOOKUP_PACING);
            }
            ensure_not_cancelled(cancellation)?;

            match lookup_acoustid(client, key, &fingerprint, window.start_seconds) {
                Ok(found) => candidates.extend(found),
                Err(error) => {
                    lookup_failed = true;
                    sample_message = error;
                }
            }
        }

        samples.push(ScanSample {
            index: sample_number,
            timestamp_seconds: window.start_seconds,
            duration_seconds: fingerprint.duration,
            status: "fingerprinted".to_string(),
            message: Some(sample_message),
        });
    }

    if enhanced_recognition {
        for (position, window) in enhanced_windows.iter().enumerate() {
            ensure_not_cancelled(cancellation)?;
            let check_number = position + 1;
            enhanced_attempted = true;

            if position > 0 {
                wait_with_cancellation(ENHANCED_LOOKUP_PACING, cancellation)?;
            }

            let enhanced_range = time_range_for_enhanced_window(window);
            emit_progress(
                app,
                "Checking discovery moments",
                &format!(
                    "Checking {}–{} ({check_number} of {enhanced_check_count}).",
                    format_duration(enhanced_range.start_seconds),
                    format_duration(enhanced_range.end_seconds),
                ),
                standard_sample_count + position,
                total_steps,
            );

            let enhanced_audio_path =
                work_dir.join(format!("enhanced-signature-{check_number}.pcm"));
            match extract_enhanced_audio_sample(
                ffmpeg,
                &source.canonical_path,
                window,
                &enhanced_audio_path,
                cancellation,
            ) {
                Ok(()) => match lookup_enhanced_recognition(
                    &enhanced_audio_path,
                    window.start_seconds,
                    cancellation,
                ) {
                    Ok(outcome) => {
                        if outcome.signature_submitted {
                            enhanced_signature_submitted = true;
                            enhanced_signature_ranges.push(enhanced_range);
                        }
                        if let Some(candidate) = outcome.candidate {
                            candidates.push(candidate);
                        }
                        if outcome.message.is_some() {
                            enhanced_failed = true;
                            enhanced_consecutive_failures += 1;
                        } else {
                            enhanced_consecutive_failures = 0;
                        }
                    }
                    Err(error) if error == CANCELLATION_MESSAGE => return Err(error),
                    Err(_) => {
                        enhanced_failed = true;
                        enhanced_consecutive_failures += 1;
                    }
                },
                Err(error) if error == CANCELLATION_MESSAGE => return Err(error),
                Err(_) => {
                    enhanced_failed = true;
                    enhanced_consecutive_failures += 1;
                }
            }

            if enhanced_consecutive_failures >= 2 {
                break;
            }
        }
    }

    ensure_not_cancelled(cancellation)?;
    let candidates = deduplicate_candidates(candidates);
    let successful_samples = samples
        .iter()
        .filter(|sample| sample.status == "fingerprinted")
        .count();
    let recognition_status = if successful_samples == 0 {
        "pipelineFailed"
    } else if api_key.is_none() && !enhanced_recognition {
        "notConfigured"
    } else if lookup_failed || enhanced_failed {
        "partialFailure"
    } else {
        "complete"
    }
    .to_string();

    let message = match recognition_status.as_str() {
        "pipelineFailed" => "SonIQ could not create a usable local fingerprint from this video.".to_string(),
        "notConfigured" => {
            "Local fingerprints are ready. Add SONIQ_ACOUSTID_KEY outside the app to enable music lookup.".to_string()
        }
        "partialFailure" if !candidates.is_empty() && !enhanced_signature_ranges.is_empty() => {
            format!(
                "SonIQ found {} suggested {} across {} approved discovery moments, although some checks could not finish. Review the completed matches.",
                candidates.len(),
                if candidates.len() == 1 { "track" } else { "tracks" },
                enhanced_signature_ranges.len(),
            )
        }
        "partialFailure" => "Some bounded recognition checks could not finish. Completed matches are still shown.".to_string(),
        _ if enhanced_attempted && candidates.is_empty() => {
            let checked = enhanced_signature_ranges.len();
            if checked > 1 {
                format!(
                    "Enhanced recognition checked {checked} approved discovery moments, but no match was returned. You can choose another video or find a more specific moment."
                )
            } else {
                "Enhanced recognition checked one approved moment, but no match was returned. You can add a track manually or choose another video.".to_string()
            }
        }
        _ if candidates.iter().any(|candidate| candidate.lookup_source == "Experimental Shazam-compatible lookup") => {
            let checked = enhanced_signature_ranges.len();
            let track_label = if candidates.len() == 1 { "track" } else { "tracks" };
            format!(
                "SonIQ found {} suggested {track_label} across {checked} approved discovery moments. Review each before saving anything.",
                candidates.len()
            )
        }
        _ if candidates.is_empty() => "No reliable matches were returned for these local samples.".to_string(),
        _ => "Local scan complete. Review every suggested match before saving anything.".to_string(),
    };

    emit_progress(
        app,
        "Local scan complete",
        &message,
        total_steps,
        total_steps,
    );

    Ok(ScanResult {
        source: video_info(source),
        samples,
        candidates,
        recognition_status,
        message,
        enhanced_recognition_attempted: enhanced_attempted,
        enhanced_signature_submitted,
        enhanced_signature_ranges,
        soundtrack_map,
        temporary_artifacts: "cleaned".to_string(),
    })
}

/**
 * Build display-only activity evidence before normal enhanced planning. The
 * PCM envelope exists only in the current temporary scan directory and is
 * intentionally reduced to compact region summaries before returning.
 */
fn derive_local_soundtrack_map(
    app: &AppHandle,
    source: &InspectedSource,
    ffmpeg: &Path,
    work_dir: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<SoundtrackMap, String> {
    if !source.duration_seconds.is_finite()
        || source.duration_seconds <= 0.0
        || source.duration_seconds > MAX_WAVEFORM_DURATION_SECONDS
    {
        return Err("This source is outside SonIQ's bounded local activity-map range.".to_string());
    }

    ensure_not_cancelled(cancellation)?;
    emit_progress(
        app,
        "Mapping local activity",
        "Finding sustained acoustic activity on this Mac.",
        0,
        1,
    );

    let full_source_range = SampleWindow {
        start_seconds: 0.0,
        duration_seconds: source.duration_seconds,
    };
    let audio_path = work_dir.join("local-activity-map.pcm");
    extract_acoustic_activity_audio_sample(
        ffmpeg,
        &source.canonical_path,
        &full_source_range,
        &audio_path,
        cancellation,
    )?;
    ensure_not_cancelled(cancellation)?;

    let maximum_bytes = (MAX_WAVEFORM_DURATION_SECONDS as u64)
        .saturating_mul(u64::from(ACOUSTIC_MAP_SAMPLE_RATE))
        .saturating_mul(2)
        .saturating_add(2);
    let metadata = fs::metadata(&audio_path)
        .map_err(|_| "SonIQ could not read the temporary local activity data.".to_string())?;
    if metadata.len() > maximum_bytes {
        return Err(
            "SonIQ stopped local activity mapping because the source was too large.".to_string(),
        );
    }

    let pcm = fs::read(&audio_path)
        .map_err(|_| "SonIQ could not read the temporary local activity data.".to_string())?;
    ensure_not_cancelled(cancellation)?;
    let envelope = calculate_acoustic_activity_envelope(
        &pcm,
        acoustic_map_bucket_count(source.duration_seconds),
    )?;
    ensure_not_cancelled(cancellation)?;
    let activity_regions = derive_acoustic_activity_regions(&envelope, source.duration_seconds);
    ensure_not_cancelled(cancellation)?;

    emit_progress(
        app,
        "Local activity mapped",
        if activity_regions.is_empty() {
            "No distinct local activity regions were prioritized; SonIQ will use representative checks."
        } else {
            "SonIQ found local activity regions to prioritize before recognition."
        },
        1,
        1,
    );

    Ok(SoundtrackMap {
        available: true,
        activity_regions,
        recommended_ranges: Vec::new(),
    })
}

fn acoustic_map_bucket_count(duration_seconds: f64) -> usize {
    ((duration_seconds * ACOUSTIC_MAP_BUCKETS_PER_SECOND).ceil() as usize)
        .clamp(1, MAX_ACOUSTIC_MAP_BUCKETS)
}

/**
 * Creates a temporary RMS-like local envelope. Callers must collapse it to
 * regions before returning anything to the renderer.
 */
fn calculate_acoustic_activity_envelope(
    pcm: &[u8],
    bucket_count: usize,
) -> Result<Vec<f32>, String> {
    if pcm.len() < 2 || !pcm.len().is_multiple_of(2) || bucket_count == 0 {
        return Err(
            "SonIQ could not create a usable local activity map from this video.".to_string(),
        );
    }

    let sample_count = pcm.len() / 2;
    let mut sums = vec![0.0_f64; bucket_count];
    let mut counts = vec![0_usize; bucket_count];
    for (index, bytes) in pcm.chunks_exact(2).enumerate() {
        let sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f64 / i16::MAX as f64;
        let bucket = (index * bucket_count / sample_count).min(bucket_count - 1);
        sums[bucket] += sample * sample;
        counts[bucket] += 1;
    }

    Ok(sums
        .into_iter()
        .zip(counts)
        .map(|(sum, count)| {
            if count == 0 {
                0.0
            } else {
                (sum / count as f64).sqrt().min(1.0) as f32
            }
        })
        .collect())
}

/**
 * Derives sustained local activity only. It never labels a region as music,
 * and deliberately returns no region when the envelope has no useful contrast.
 */
fn derive_acoustic_activity_regions(
    envelope: &[f32],
    duration_seconds: f64,
) -> Vec<AcousticActivityRegion> {
    if envelope.is_empty() || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Vec::new();
    }
    if envelope
        .iter()
        .any(|level| !level.is_finite() || *level < 0.0)
    {
        return Vec::new();
    }

    let mut ordered = envelope.to_vec();
    ordered.sort_by(|left, right| left.total_cmp(right));
    let baseline = ordered[(ordered.len() - 1) / 4];
    let upper_quartile = ordered[(ordered.len() - 1) * 3 / 4];
    let peak = *ordered.last().unwrap_or(&0.0);
    // A very brief peak should not hide an otherwise sustained region. When a
    // substantial upper band exists, it provides a more stable threshold; an
    // isolated region still falls back to the local peak.
    let reference_level = if upper_quartile - baseline >= MIN_ACOUSTIC_ACTIVITY_CONTRAST {
        upper_quartile
    } else {
        peak
    };
    if reference_level < MIN_ACOUSTIC_ACTIVITY_LEVEL
        || reference_level - baseline < MIN_ACOUSTIC_ACTIVITY_CONTRAST
    {
        return Vec::new();
    }

    let threshold =
        (baseline + (reference_level - baseline) * 0.35).max(MIN_ACOUSTIC_ACTIVITY_LEVEL);
    let bucket_duration = duration_seconds / envelope.len() as f64;
    if !bucket_duration.is_finite() || bucket_duration <= 0.0 {
        return Vec::new();
    }

    let mut active = envelope
        .iter()
        .map(|level| *level >= threshold)
        .collect::<Vec<_>>();
    bridge_short_activity_gaps(
        &mut active,
        ((MAX_ACOUSTIC_ACTIVITY_GAP_SECONDS / bucket_duration).floor() as usize).max(1),
    );

    let minimum_bucket_count =
        (MIN_ACOUSTIC_ACTIVITY_REGION_SECONDS / bucket_duration).ceil() as usize;
    let mut regions = Vec::new();
    let mut start = None;
    for (index, is_active) in active.iter().copied().enumerate() {
        match (start, is_active) {
            (None, true) => start = Some(index),
            (Some(region_start), false) => {
                push_acoustic_activity_region(
                    &mut regions,
                    envelope,
                    duration_seconds,
                    region_start,
                    index,
                    minimum_bucket_count,
                );
                start = None;
            }
            _ => {}
        }
    }
    if let Some(region_start) = start {
        push_acoustic_activity_region(
            &mut regions,
            envelope,
            duration_seconds,
            region_start,
            envelope.len(),
            minimum_bucket_count,
        );
    }

    regions.sort_by(|left, right| {
        acoustic_activity_region_weight(right)
            .total_cmp(&acoustic_activity_region_weight(left))
            .then_with(|| left.start_seconds.total_cmp(&right.start_seconds))
    });
    regions.truncate(MAX_ACOUSTIC_ACTIVITY_REGIONS);
    regions.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    regions
}

fn bridge_short_activity_gaps(active: &mut [bool], maximum_gap_buckets: usize) {
    let mut index = 0;
    while index < active.len() {
        if active[index] {
            index += 1;
            continue;
        }

        let gap_start = index;
        while index < active.len() && !active[index] {
            index += 1;
        }
        let gap_end = index;
        if gap_start > 0 && gap_end < active.len() && gap_end - gap_start <= maximum_gap_buckets {
            active[gap_start..gap_end].fill(true);
        }
    }
}

fn push_acoustic_activity_region(
    regions: &mut Vec<AcousticActivityRegion>,
    envelope: &[f32],
    duration_seconds: f64,
    start_bucket: usize,
    end_bucket: usize,
    minimum_bucket_count: usize,
) {
    if end_bucket.saturating_sub(start_bucket) < minimum_bucket_count || start_bucket >= end_bucket
    {
        return;
    }

    let activity_level = envelope[start_bucket..end_bucket]
        .iter()
        .copied()
        .sum::<f32>()
        / (end_bucket - start_bucket) as f32;
    let start_seconds = (start_bucket as f64 * duration_seconds / envelope.len() as f64)
        .clamp(0.0, duration_seconds);
    let end_seconds = (end_bucket as f64 * duration_seconds / envelope.len() as f64)
        .clamp(start_seconds, duration_seconds);
    if end_seconds > start_seconds && activity_level.is_finite() {
        regions.push(AcousticActivityRegion {
            start_seconds,
            end_seconds,
            activity_level: activity_level.clamp(0.0, 1.0),
        });
    }
}

fn acoustic_activity_region_weight(region: &AcousticActivityRegion) -> f32 {
    let duration_weight = (region.end_seconds - region.start_seconds).max(1.0).sqrt() as f32;
    region.activity_level * duration_weight
}

fn generate_waveform_envelope_for_range(
    app: &AppHandle,
    source: InspectedSource,
    range: SampleWindow,
    cancellation: Arc<AtomicBool>,
) -> Result<WaveformEnvelope, String> {
    ensure_not_cancelled(&cancellation)?;
    let ffmpeg = binary_path("ffmpeg")?;
    let work_dir = temporary_scan_directory()?;
    let waveform_result = (|| {
        emit_progress(
            app,
            "Generating local waveform",
            "Creating a compact display envelope on this Mac.",
            0,
            1,
        );

        let audio_path = work_dir.join("waveform-envelope.pcm");
        extract_waveform_audio_sample(
            &ffmpeg,
            &source.canonical_path,
            &range,
            &audio_path,
            &cancellation,
        )?;
        ensure_not_cancelled(&cancellation)?;

        let metadata = fs::metadata(&audio_path)
            .map_err(|_| "SonIQ could not read the temporary local waveform data.".to_string())?;
        let maximum_bytes = (MAX_WAVEFORM_DURATION_SECONDS as u64)
            .saturating_mul(u64::from(WAVEFORM_SAMPLE_RATE))
            .saturating_mul(2)
            .saturating_add(2);
        if metadata.len() > maximum_bytes {
            return Err(
                "SonIQ stopped waveform generation because the selected range was too large."
                    .to_string(),
            );
        }

        let pcm = fs::read(&audio_path)
            .map_err(|_| "SonIQ could not read the temporary local waveform data.".to_string())?;
        ensure_not_cancelled(&cancellation)?;
        let amplitudes =
            calculate_waveform_envelope(&pcm, waveform_bucket_count(range.duration_seconds))?;

        emit_progress(
            app,
            "Moment map ready",
            "The compact waveform stayed on this Mac.",
            1,
            1,
        );

        Ok(WaveformEnvelope {
            source: video_info(&source),
            start_seconds: range.start_seconds,
            end_seconds: range.start_seconds + range.duration_seconds,
            bucket_duration_seconds: range.duration_seconds / amplitudes.len() as f64,
            amplitudes,
        })
    })();

    finish_temporary_work(waveform_result, &work_dir, "waveform files")
}

fn waveform_bucket_count(duration_seconds: f64) -> usize {
    ((duration_seconds * WAVEFORM_BUCKETS_PER_SECOND).ceil() as usize)
        .clamp(1, MAX_WAVEFORM_BUCKETS)
}

fn calculate_waveform_envelope(pcm: &[u8], bucket_count: usize) -> Result<Vec<f32>, String> {
    if pcm.len() < 2 || !pcm.len().is_multiple_of(2) || bucket_count == 0 {
        return Err("SonIQ could not create a usable local waveform from this video.".to_string());
    }

    let sample_count = pcm.len() / 2;
    let mut amplitudes = vec![0.0_f32; bucket_count];
    for (index, bytes) in pcm.chunks_exact(2).enumerate() {
        let sample = i16::from_le_bytes([bytes[0], bytes[1]]);
        let amplitude = ((sample as i32).abs() as f32 / i16::MAX as f32).min(1.0);
        let bucket = (index * bucket_count / sample_count).min(bucket_count - 1);
        amplitudes[bucket] = amplitudes[bucket].max(amplitude);
    }

    Ok(amplitudes)
}

fn probe_duration(source: &Path) -> Result<f64, String> {
    let ffprobe = binary_path("ffprobe")?;
    let mut command = Command::new(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(source);

    let output = run_capture(command, &Arc::new(AtomicBool::new(false)))?;
    let duration = output
        .trim()
        .parse::<f64>()
        .map_err(|_| "SonIQ could not read this video’s duration.".to_string())?;

    if duration.is_finite() && duration > 0.0 {
        Ok(duration)
    } else {
        Err("SonIQ could not find a usable duration in that video.".to_string())
    }
}

fn extract_audio_sample(
    ffmpeg: &Path,
    source: &Path,
    window: &SampleWindow,
    destination: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{:.3}", window.start_seconds))
        .arg("-i")
        .arg(source)
        .arg("-t")
        .arg(format!("{:.3}", window.duration_seconds))
        .args(["-vn", "-ac", "1", "-ar", "11025", "-c:a", "pcm_s16le", "-y"])
        .arg(destination);

    run_status(command, cancellation).map_err(|error| {
        if error == CANCELLATION_MESSAGE {
            error
        } else {
            "SonIQ could not extract a local audio sample from this video.".to_string()
        }
    })
}

fn extract_enhanced_audio_sample(
    ffmpeg: &Path,
    source: &Path,
    window: &SampleWindow,
    destination: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{:.3}", window.start_seconds))
        .arg("-i")
        .arg(source)
        .arg("-t")
        .arg(format!(
            "{:.3}",
            window.duration_seconds.min(ENHANCED_SAMPLE_SECONDS)
        ))
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-y"])
        .arg(destination);

    run_status(command, cancellation).map_err(|error| {
        if error == CANCELLATION_MESSAGE {
            error
        } else {
            "SonIQ could not prepare the approved audio sample for enhanced recognition."
                .to_string()
        }
    })
}

fn extract_waveform_audio_sample(
    ffmpeg: &Path,
    source: &Path,
    range: &SampleWindow,
    destination: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{:.3}", range.start_seconds))
        .arg("-i")
        .arg(source)
        .arg("-t")
        .arg(format!("{:.3}", range.duration_seconds))
        .args(["-vn", "-ac", "1", "-ar"])
        .arg(WAVEFORM_SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-y"])
        .arg(destination);

    run_status(command, cancellation).map_err(|error| {
        if error == CANCELLATION_MESSAGE {
            error
        } else {
            "SonIQ could not create a local waveform from this video.".to_string()
        }
    })
}

fn extract_acoustic_activity_audio_sample(
    ffmpeg: &Path,
    source: &Path,
    range: &SampleWindow,
    destination: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{:.3}", range.start_seconds))
        .arg("-i")
        .arg(source)
        .arg("-t")
        .arg(format!("{:.3}", range.duration_seconds))
        .args(["-vn", "-ac", "1", "-ar"])
        .arg(ACOUSTIC_MAP_SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-y"])
        .arg(destination);

    run_status(command, cancellation).map_err(|error| {
        if error == CANCELLATION_MESSAGE {
            error
        } else {
            "SonIQ could not create a local activity map from this video.".to_string()
        }
    })
}

fn create_fingerprint(
    fpcalc: &Path,
    audio_path: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<FpcalcOutput, String> {
    let mut command = Command::new(fpcalc);
    command.args(["-json"]).arg(audio_path);

    let output = run_capture(command, cancellation)?;
    let fingerprint: FpcalcOutput = serde_json::from_str(&output)
        .map_err(|_| "SonIQ could not create a usable fingerprint from this sample.".to_string())?;

    if fingerprint.fingerprint.trim().is_empty()
        || !fingerprint.duration.is_finite()
        || fingerprint.duration <= 0.0
    {
        return Err("SonIQ could not create a usable fingerprint from this sample.".to_string());
    }

    Ok(fingerprint)
}

fn lookup_acoustid(
    client: &reqwest::blocking::Client,
    api_key: &str,
    fingerprint: &FpcalcOutput,
    timestamp_seconds: f64,
) -> Result<Vec<CandidateTrack>, String> {
    let duration = fingerprint.duration.round().max(1.0).to_string();
    let mut url = reqwest::Url::parse("https://api.acoustid.org/v2/lookup")
        .map_err(|_| "SonIQ could not prepare the recognition request.".to_string())?;
    url.query_pairs_mut()
        .append_pair("client", api_key)
        .append_pair("meta", "recordings")
        .append_pair("duration", &duration)
        .append_pair("fingerprint", &fingerprint.fingerprint);

    let response = client
        .get(url)
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "The recognition service timed out. Try this moment again or continue with the local results."
                    .to_string()
            } else {
                "This sample could not reach the recognition service. Try this moment again when you are online."
                    .to_string()
            }
        })?
        .error_for_status()
        .map_err(|_| "This sample was not accepted by the recognition service.".to_string())?
        .json::<AcoustIdResponse>()
        .map_err(|_| "The recognition service returned an unreadable response.".to_string())?;

    if response.status != "ok" {
        return Err("The recognition service could not process this sample.".to_string());
    }

    let mut candidates = Vec::new();
    for result in response.results.unwrap_or_default() {
        for recording in result.recordings.unwrap_or_default() {
            let title = recording.title.unwrap_or_default().trim().to_string();
            let artist = recording
                .artists
                .unwrap_or_default()
                .into_iter()
                .filter_map(|artist| artist.name)
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(", ");

            if title.is_empty() || artist.is_empty() {
                continue;
            }

            let normalized_key = normalized_track_key(&title, &artist);
            candidates.push(CandidateTrack {
                id: format!(
                    "{}-{}",
                    normalized_key,
                    (timestamp_seconds * 1000.0).round() as u64
                ),
                title,
                artist,
                score: result.score,
                confidence: confidence_for_score(result.score).to_string(),
                timestamps: vec![timestamp_seconds],
                musicbrainz_id: recording.id,
                artwork_url: None,
                lookup_source: "AcoustID / MusicBrainz".to_string(),
            });
        }
    }

    Ok(candidates)
}

fn no_track_preview() -> TrackPreview {
    TrackPreview {
        preview_url: None,
        track_view_url: None,
        attribution: "Provided courtesy of iTunes",
    }
}

fn validate_preview_display_text(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Choose a valid {label} before requesting a preview."
        ));
    }
    if trimmed.chars().count() > MAX_PREVIEW_DISPLAY_TEXT_LENGTH
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!(
            "Choose a valid {label} before requesting a preview."
        ));
    }
    Ok(trimmed.to_string())
}

/**
 * iTunes Search API responses are treated as untrusted display data. A preview
 * is usable only if its title/artist resolve conservatively and both returned
 * URLs are well-formed HTTPS URLs. No response is cached or written to disk.
 */
fn lookup_itunes_track_preview(title: &str, artist: &str) -> TrackPreview {
    let client = match reqwest::blocking::Client::builder()
        .timeout(PREVIEW_LOOKUP_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return no_track_preview(),
    };

    let mut url = match reqwest::Url::parse("https://itunes.apple.com/search") {
        Ok(url) => url,
        Err(_) => return no_track_preview(),
    };
    url.query_pairs_mut()
        .append_pair("term", &format!("{title} {artist}"))
        .append_pair("media", "music")
        .append_pair("entity", "song")
        .append_pair("limit", "5");

    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return no_track_preview(),
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(_) => return no_track_preview(),
    };
    let response = match response.json::<ItunesSearchResponse>() {
        Ok(response) => response,
        Err(_) => return no_track_preview(),
    };

    preview_from_itunes_results(title, artist, &response.results.unwrap_or_default())
        .unwrap_or_else(no_track_preview)
}

fn preview_from_itunes_results(
    title: &str,
    artist: &str,
    results: &[ItunesSearchResult],
) -> Option<TrackPreview> {
    let expected_title = normalized_track_component(title);
    let expected_artist = normalized_track_component(artist);
    if expected_title.is_empty() || expected_artist.is_empty() {
        return None;
    }

    let exact_match = results.iter().find(|result| {
        let result_title = result
            .track_name
            .as_deref()
            .map(normalized_track_component)
            .unwrap_or_default();
        let result_artist = result
            .artist_name
            .as_deref()
            .map(normalized_track_component)
            .unwrap_or_default();
        result_title == expected_title && result_artist == expected_artist
    });

    if let Some(result) = exact_match {
        return preview_from_itunes_result(result);
    }

    // A title-only result can be a useful fallback only when the service
    // returned exactly one result. Multiple same-title releases are ambiguous.
    if results.len() != 1 {
        return None;
    }
    let result = results.first()?;
    let result_title = result
        .track_name
        .as_deref()
        .map(normalized_track_component)
        .unwrap_or_default();
    let has_artist = result
        .artist_name
        .as_deref()
        .map(normalized_track_component)
        .is_some_and(|artist| !artist.is_empty());
    if result_title != expected_title || !has_artist {
        return None;
    }

    preview_from_itunes_result(result)
}

fn preview_from_itunes_result(result: &ItunesSearchResult) -> Option<TrackPreview> {
    let preview_url = result
        .preview_url
        .as_deref()
        .filter(|url| is_safe_https_url(url))?;
    let track_view_url = result
        .track_view_url
        .as_deref()
        .filter(|url| is_safe_https_url(url))?;

    Some(TrackPreview {
        preview_url: Some(preview_url.to_string()),
        track_view_url: Some(track_view_url.to_string()),
        attribution: "Provided courtesy of iTunes",
    })
}

fn lookup_enhanced_recognition(
    audio_path: &Path,
    timestamp_seconds: f64,
    cancellation: &Arc<AtomicBool>,
) -> Result<EnhancedRecognitionOutcome, String> {
    let node = node_path()?;
    let script = enhanced_recognition_script_path()?;
    let mut command = Command::new(node);
    command.arg(script).arg(audio_path);

    let output = run_capture_with_timeout(
        command,
        cancellation,
        ENHANCED_LOOKUP_TIMEOUT,
        "Enhanced recognition timed out. Try this moment again or continue with the local results.",
    )
    .map_err(|error| {
        if error == CANCELLATION_MESSAGE || error.starts_with("Enhanced recognition timed out") {
            error
        } else {
            "Enhanced recognition is unavailable right now. SonIQ kept the local scan and AcoustID results."
                .to_string()
        }
    })?;

    let response = match serde_json::from_str::<Option<EnhancedRecognitionResponse>>(&output) {
        Ok(response) => response,
        Err(_) => {
            return Ok(EnhancedRecognitionOutcome {
                candidate: None,
                signature_submitted: true,
                message: Some(
                    "Enhanced recognition returned an unreadable response. SonIQ kept the local scan and AcoustID results."
                        .to_string(),
                ),
            });
        }
    };

    let Some(response) = response else {
        return Ok(EnhancedRecognitionOutcome {
            candidate: None,
            signature_submitted: true,
            message: None,
        });
    };
    let title = response.title.unwrap_or_default().trim().to_string();
    let artist = response.artist.unwrap_or_default().trim().to_string();
    if title.is_empty() || artist.is_empty() {
        return Ok(EnhancedRecognitionOutcome {
            candidate: None,
            signature_submitted: true,
            message: Some(
                "Enhanced recognition returned an incomplete response. SonIQ kept the local scan and AcoustID results."
                    .to_string(),
            ),
        });
    }

    let normalized_key = normalized_track_key(&title, &artist);
    let artwork_url = response.artwork_url.filter(|url| is_safe_artwork_url(url));
    Ok(EnhancedRecognitionOutcome {
        candidate: Some(CandidateTrack {
            id: format!(
                "shazam-{normalized_key}-{}",
                (timestamp_seconds * 1000.0).round() as u64
            ),
            title,
            artist,
            score: 1.0,
            confidence: "High confidence".to_string(),
            timestamps: vec![timestamp_seconds],
            musicbrainz_id: None,
            artwork_url,
            lookup_source: "Experimental Shazam-compatible lookup".to_string(),
        }),
        signature_submitted: true,
        message: None,
    })
}

fn deduplicate_candidates(candidates: Vec<CandidateTrack>) -> Vec<CandidateTrack> {
    let mut grouped: HashMap<String, CandidateTrack> = HashMap::new();

    for mut candidate in candidates {
        let key = normalized_track_key(&candidate.title, &candidate.artist);
        match grouped.get_mut(&key) {
            Some(existing) => {
                let candidate_timestamps = std::mem::take(&mut candidate.timestamps);
                for timestamp in candidate_timestamps {
                    if !existing
                        .timestamps
                        .iter()
                        .any(|current| (*current - timestamp).abs() < 0.01)
                    {
                        existing.timestamps.push(timestamp);
                    }
                }
                if candidate.score > existing.score {
                    candidate.timestamps = std::mem::take(&mut existing.timestamps);
                    if candidate.artwork_url.is_none() {
                        candidate.artwork_url = existing.artwork_url.clone();
                    }
                    if candidate.musicbrainz_id.is_none() {
                        candidate.musicbrainz_id = existing.musicbrainz_id.clone();
                    }
                    *existing = candidate;
                } else {
                    if existing.musicbrainz_id.is_none() {
                        existing.musicbrainz_id = candidate.musicbrainz_id;
                    }
                    if existing.artwork_url.is_none() {
                        existing.artwork_url = candidate.artwork_url;
                    }
                }
            }
            None => {
                grouped.insert(key, candidate);
            }
        }
    }

    let mut deduplicated = grouped.into_values().collect::<Vec<_>>();
    for candidate in &mut deduplicated {
        candidate
            .timestamps
            .sort_by(|left, right| left.total_cmp(right));
    }
    deduplicated.sort_by(|left, right| {
        let left_timestamp = left.timestamps.first().copied().unwrap_or(f64::INFINITY);
        let right_timestamp = right.timestamps.first().copied().unwrap_or(f64::INFINITY);
        left_timestamp
            .total_cmp(&right_timestamp)
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| {
                normalized_track_key(&left.title, &left.artist)
                    .cmp(&normalized_track_key(&right.title, &right.artist))
            })
    });
    deduplicated
}

fn is_safe_artwork_url(url: &str) -> bool {
    url.len() <= 2_048 && url.starts_with("https://")
}

fn is_safe_https_url(value: &str) -> bool {
    if value.len() > 2_048 {
        return false;
    }
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn plan_sample_windows(duration_seconds: f64) -> Vec<SampleWindow> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Vec::new();
    }

    let sample_count = if duration_seconds >= MIN_WINDOW_SECONDS * 3.0 {
        3
    } else {
        (duration_seconds / MIN_WINDOW_SECONDS).floor().max(1.0) as usize
    };
    let slot_duration = duration_seconds / sample_count as f64;
    let window_duration = TARGET_SAMPLE_SECONDS.min(slot_duration);

    (0..sample_count)
        .map(|index| SampleWindow {
            start_seconds: index as f64 * slot_duration + (slot_duration - window_duration) / 2.0,
            duration_seconds: window_duration,
        })
        .collect()
}

/**
 * A bounded discovery sweep for the experimental recognizer. The endpoint can
 * identify one track per signature, so a single signature can never discover
 * a soundtrack. We deliberately cap the sweep at six short moments: clips up
 * to 48 seconds are covered end-to-end; longer clips receive six evenly
 * distributed representative moments.
 */
fn plan_enhanced_discovery_windows(duration_seconds: f64) -> Vec<SampleWindow> {
    plan_enhanced_signature_windows(
        SampleWindow {
            start_seconds: 0.0,
            duration_seconds,
        },
        MAX_ENHANCED_DISCOVERY_SIGNATURES,
    )
}

/**
 * Prioritizes one safely centered eight-second window per distinct local
 * activity region, then fills the remaining bounded slots from the existing
 * deterministic discovery plan. A map with no useful regions is therefore a
 * normal, stable fallback rather than a scan failure.
 */
fn plan_enhanced_discovery_windows_for_map(
    duration_seconds: f64,
    activity_regions: &[AcousticActivityRegion],
) -> Vec<SampleWindow> {
    let fallback = plan_enhanced_discovery_windows(duration_seconds);
    if fallback.is_empty() || activity_regions.is_empty() {
        return fallback;
    }

    let signature_duration = duration_seconds.min(ENHANCED_SAMPLE_SECONDS);
    let last_start = (duration_seconds - signature_duration).max(0.0);
    let mut ranked_regions = activity_regions
        .iter()
        .filter(|region| {
            region.start_seconds.is_finite()
                && region.end_seconds.is_finite()
                && region.activity_level.is_finite()
                && region.start_seconds >= 0.0
                && region.end_seconds > region.start_seconds
                && region.end_seconds <= duration_seconds + 0.001
        })
        .collect::<Vec<_>>();
    ranked_regions.sort_by(|left, right| {
        acoustic_activity_region_weight(right)
            .total_cmp(&acoustic_activity_region_weight(left))
            .then_with(|| left.start_seconds.total_cmp(&right.start_seconds))
    });

    let mut planned = Vec::with_capacity(MAX_ENHANCED_DISCOVERY_SIGNATURES);
    for region in ranked_regions {
        if planned.len() == MAX_ENHANCED_DISCOVERY_SIGNATURES {
            break;
        }
        let centered_start = ((region.start_seconds + region.end_seconds) / 2.0
            - signature_duration / 2.0)
            .clamp(0.0, last_start);
        push_distinct_enhanced_window(
            &mut planned,
            SampleWindow {
                start_seconds: centered_start,
                duration_seconds: signature_duration,
            },
        );
    }

    for fallback_window in fallback {
        if planned.len() == MAX_ENHANCED_DISCOVERY_SIGNATURES {
            break;
        }
        push_distinct_enhanced_window(&mut planned, fallback_window);
    }

    planned.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    planned
}

fn push_distinct_enhanced_window(planned: &mut Vec<SampleWindow>, window: SampleWindow) {
    if planned.len() >= MAX_ENHANCED_DISCOVERY_SIGNATURES
        || planned.iter().any(|existing| {
            (existing.start_seconds - window.start_seconds).abs()
                < ENHANCED_WINDOW_START_EPSILON_SECONDS
        })
    {
        return;
    }
    planned.push(window);
}

/** A user-selected 8–28 second moment can be swept in up to four signatures. */
fn plan_enhanced_targeted_windows(window: &SampleWindow) -> Vec<SampleWindow> {
    plan_enhanced_signature_windows(window.clone(), MAX_ENHANCED_TARGETED_SIGNATURES)
}

fn plan_enhanced_signature_windows(
    window: SampleWindow,
    maximum_signatures: usize,
) -> Vec<SampleWindow> {
    if !window.start_seconds.is_finite()
        || !window.duration_seconds.is_finite()
        || window.duration_seconds <= 0.0
        || maximum_signatures == 0
    {
        return Vec::new();
    }

    let duration = window.duration_seconds;
    let signature_duration = duration.min(ENHANCED_SAMPLE_SECONDS);
    if duration <= ENHANCED_SAMPLE_SECONDS {
        return vec![SampleWindow {
            start_seconds: window.start_seconds,
            duration_seconds: signature_duration,
        }];
    }

    let nominal_count = (duration / ENHANCED_SAMPLE_SECONDS).ceil() as usize;
    let count = nominal_count.clamp(1, maximum_signatures);
    let last_start_offset = (duration - signature_duration).max(0.0);
    let should_distribute = nominal_count > maximum_signatures && count > 1;

    (0..count)
        .map(|index| {
            let offset = if should_distribute {
                last_start_offset * index as f64 / (count - 1) as f64
            } else if index + 1 == count {
                last_start_offset
            } else {
                (index as f64 * ENHANCED_SAMPLE_SECONDS).min(last_start_offset)
            };
            SampleWindow {
                start_seconds: window.start_seconds + offset,
                duration_seconds: signature_duration,
            }
        })
        .collect()
}

fn time_range_for_enhanced_window(window: &SampleWindow) -> TimeRange {
    let duration = window.duration_seconds.clamp(0.0, ENHANCED_SAMPLE_SECONDS);
    TimeRange {
        start_seconds: window.start_seconds,
        end_seconds: window.start_seconds + duration,
    }
}

fn wait_with_cancellation(
    duration: Duration,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        ensure_not_cancelled(cancellation)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(50)));
    }
    ensure_not_cancelled(cancellation)
}

fn confidence_for_score(score: f64) -> &'static str {
    if score >= 0.86 {
        "High confidence"
    } else if score >= 0.65 {
        "Possible match"
    } else {
        "Needs review"
    }
}

fn normalized_track_key(title: &str, artist: &str) -> String {
    format!(
        "{}::{}",
        normalized_track_component(title),
        normalized_track_component(artist)
    )
}

fn normalized_track_component(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn format_duration(duration_seconds: f64) -> String {
    let rounded = duration_seconds.max(0.0).round() as u64;
    let minutes = rounded / 60;
    let seconds = rounded % 60;
    format!("{minutes:02}:{seconds:02}")
}

fn node_path() -> Result<PathBuf, String> {
    binary_path("node").map_err(|_| {
        "Enhanced recognition needs Node.js on this demo Mac. Install it, then relaunch SonIQ with npm run tauri dev."
            .to_string()
    })
}

fn enhanced_recognition_script_path() -> Result<PathBuf, String> {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "SonIQ could not locate the enhanced-recognition adapter.".to_string())?;
    let script = workspace_root.join("scripts/recognition-adapter.cjs");
    if script.is_file() {
        Ok(script)
    } else {
        Err("Enhanced recognition is not installed in this SonIQ workspace.".to_string())
    }
}

fn binary_path(binary: &str) -> Result<PathBuf, String> {
    let paths = [
        format!("/opt/homebrew/bin/{binary}"),
        format!("/usr/local/bin/{binary}"),
        format!("/opt/local/bin/{binary}"),
        format!("/usr/bin/{binary}"),
    ];

    paths
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "SonIQ needs {binary} for local scanning. On macOS, install the prerequisites with: brew install ffmpeg chromaprint"
            )
        })
}

fn temporary_scan_directory() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "SonIQ could not prepare temporary scan storage.".to_string())?
        .as_nanos();
    let directory = env::temp_dir().join(format!("soniq-scan-{}-{nonce}", std::process::id()));
    fs::create_dir(&directory)
        .map_err(|_| "SonIQ could not create temporary local scan storage.".to_string())?;
    Ok(directory)
}

fn finish_temporary_work<T>(
    result: Result<T, String>,
    work_dir: &Path,
    artifact_label: &str,
) -> Result<T, String> {
    let cleanup_result = fs::remove_dir_all(work_dir)
        .map_err(|_| format!("SonIQ could not clear its temporary {artifact_label}."));

    match (result, cleanup_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(result), Ok(())) => Ok(result),
    }
}

fn ensure_not_cancelled(cancellation: &AtomicBool) -> Result<(), String> {
    if cancellation.load(Ordering::SeqCst) {
        Err(CANCELLATION_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

fn run_status(mut command: Command, cancellation: &Arc<AtomicBool>) -> Result<(), String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "SonIQ could not start the local media tool.".to_string())?;

    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLATION_MESSAGE.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err("The local media tool could not process this sample.".to_string())
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("SonIQ could not read the local media tool state.".to_string()),
        }
    }
}

fn run_capture(command: Command, cancellation: &Arc<AtomicBool>) -> Result<String, String> {
    run_capture_inner(command, cancellation, None, "")
}

fn run_capture_with_timeout(
    command: Command,
    cancellation: &Arc<AtomicBool>,
    timeout: Duration,
    timeout_message: &str,
) -> Result<String, String> {
    run_capture_inner(command, cancellation, Some(timeout), timeout_message)
}

fn run_capture_inner(
    mut command: Command,
    cancellation: &Arc<AtomicBool>,
    timeout: Option<Duration>,
    timeout_message: &str,
) -> Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "SonIQ could not start the local media tool.".to_string())?;
    let started_at = Instant::now();

    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLATION_MESSAGE.to_string());
        }
        if timeout.is_some_and(|limit| started_at.elapsed() >= limit) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(timeout_message.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_string(&mut output).map_err(|_| {
                        "SonIQ could not read the local media tool output.".to_string()
                    })?;
                }
                return Ok(output);
            }
            Ok(Some(_)) => {
                return Err("The local media tool could not process this video.".to_string())
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("SonIQ could not read the local media tool state.".to_string()),
        }
    }
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    detail: &str,
    completed_samples: usize,
    total_samples: usize,
) {
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            stage: stage.to_string(),
            detail: detail.to_string(),
            completed_samples,
            total_samples,
        },
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ScanController::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            inspect_video,
            run_local_scan,
            generate_waveform_envelope,
            run_targeted_recovery,
            lookup_track_preview,
            save_cue_sheet,
            cancel_active_scan,
            cancel_active_waveform
        ])
        .run(tauri::generate_context!())
        .expect("error while running SonIQ");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_source(duration_seconds: f64) -> InspectedSource {
        InspectedSource {
            canonical_path: PathBuf::from("/tmp/soniq-test-source.mov"),
            file_name: "test-source.mov".to_string(),
            duration_seconds,
        }
    }

    fn unique_test_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("soniq-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn waveform_ranges_require_complete_bounded_input() {
        let short_source = test_source(120.0);
        let default_range = validate_waveform_range(&short_source, None, None).unwrap();
        assert_eq!(default_range.start_seconds, 0.0);
        assert_eq!(default_range.duration_seconds, 120.0);

        assert!(validate_waveform_range(&short_source, Some(0.0), None).is_err());
        assert!(validate_waveform_range(&short_source, Some(-1.0), Some(4.0)).is_err());
        assert!(validate_waveform_range(&short_source, Some(118.0), Some(121.0)).is_err());

        let long_source = test_source(MAX_WAVEFORM_DURATION_SECONDS + 1.0);
        assert!(validate_waveform_range(&long_source, None, None).is_err());
        assert!(validate_waveform_range(
            &long_source,
            Some(0.0),
            Some(MAX_WAVEFORM_DURATION_SECONDS + 0.1)
        )
        .is_err());
    }

    #[test]
    fn targeted_recovery_range_is_explicit_and_capped() {
        let source = test_source(90.0);
        let valid = validate_targeted_recovery_range(&source, 12.0, 20.0).unwrap();
        assert_eq!(valid.start_seconds, 12.0);
        assert_eq!(valid.duration_seconds, TARGETED_RECOVERY_MIN_SECONDS);

        assert!(validate_targeted_recovery_range(&source, 12.0, 19.9).is_err());
        assert!(validate_targeted_recovery_range(
            &source,
            0.0,
            TARGETED_RECOVERY_MAX_SECONDS + 0.1
        )
        .is_err());
        assert!(validate_targeted_recovery_range(&source, 85.0, 93.0).is_err());
    }

    #[test]
    fn waveform_envelope_is_compact_and_normalized() {
        let pcm = [0_u8, 0, 0xff, 0x7f, 0, 0x80, 0, 0];
        let amplitudes = calculate_waveform_envelope(&pcm, 2).unwrap();

        assert_eq!(amplitudes.len(), 2);
        assert!(amplitudes
            .iter()
            .all(|amplitude| (0.0..=1.0).contains(amplitude)));
        assert!(amplitudes.iter().any(|amplitude| *amplitude > 0.99));
        assert!(calculate_waveform_envelope(&[0], 2).is_err());
        assert_eq!(waveform_bucket_count(1000.0), MAX_WAVEFORM_BUCKETS);
    }

    #[test]
    fn waveform_work_is_cancellable_without_blocking_recovery() {
        let controller = ScanController::default();
        let source = test_source(90.0);
        controller.approve(source.canonical_path.clone());

        let first_waveform = controller.start_waveform(&source.canonical_path).unwrap();
        let second_waveform = controller.start_waveform(&source.canonical_path).unwrap();
        assert!(first_waveform.load(Ordering::SeqCst));
        assert!(!second_waveform.load(Ordering::SeqCst));

        let recovery = controller.start(&source.canonical_path).unwrap();
        assert!(!recovery.load(Ordering::SeqCst));
        controller.clear(&recovery);

        controller.clear_waveform(&first_waveform);
        assert!(controller.cancel_waveform());
        assert!(second_waveform.load(Ordering::SeqCst));
        controller.clear_waveform(&second_waveform);
    }

    #[test]
    fn temporary_work_is_removed_after_success_and_failure() {
        let successful_directory = unique_test_directory("cleanup-success");
        fs::create_dir(&successful_directory).unwrap();
        fs::write(successful_directory.join("temporary.pcm"), b"local only").unwrap();
        finish_temporary_work(Ok(()), &successful_directory, "test files").unwrap();
        assert!(!successful_directory.exists());

        let failed_directory = unique_test_directory("cleanup-failure");
        fs::create_dir(&failed_directory).unwrap();
        fs::write(failed_directory.join("temporary.pcm"), b"local only").unwrap();
        let result = finish_temporary_work::<()>(
            Err("expected test failure".to_string()),
            &failed_directory,
            "test files",
        );
        assert_eq!(result.unwrap_err(), "expected test failure");
        assert!(!failed_directory.exists());
    }

    #[test]
    fn cue_sheet_save_is_limited_to_new_structured_files() {
        let directory = unique_test_directory("cue-sheet");
        fs::create_dir(&directory).unwrap();
        let destination = directory.join("soundtrack.csv");

        save_cue_sheet(
            destination.to_string_lossy().to_string(),
            "00:00,Track".to_string(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), "00:00,Track");
        assert!(
            save_cue_sheet(destination.to_string_lossy().to_string(), "new".to_string())
                .unwrap_err()
                .contains("already exists")
        );
        assert!(validate_cue_sheet_destination(
            &directory.join("soundtrack.txt").to_string_lossy(),
            "contents"
        )
        .is_err());
        assert!(validate_cue_sheet_destination(
            &directory.join("too-large.json").to_string_lossy(),
            &"x".repeat(MAX_CUE_SHEET_BYTES + 1)
        )
        .is_err());

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn long_video_uses_three_non_overlapping_windows() {
        let windows = plan_sample_windows(136.0);
        assert_eq!(windows.len(), 3);
        assert!(windows[0].start_seconds + windows[0].duration_seconds <= windows[1].start_seconds);
        assert!(windows[1].start_seconds + windows[1].duration_seconds <= windows[2].start_seconds);
        assert!(windows
            .iter()
            .all(|window| window.duration_seconds <= TARGET_SAMPLE_SECONDS));
    }

    #[test]
    fn short_video_never_requests_an_invalid_range() {
        let duration = 15.0;
        let windows = plan_sample_windows(duration);
        assert_eq!(windows.len(), 1);
        assert!(windows.iter().all(|window| {
            window.start_seconds >= 0.0
                && window.start_seconds + window.duration_seconds <= duration
        }));
    }

    #[test]
    fn enhanced_discovery_covers_short_clips_and_stays_bounded_for_long_ones() {
        let short = plan_enhanced_discovery_windows(47.0);
        assert_eq!(short.len(), 6);
        assert_eq!(short[0].start_seconds, 0.0);
        assert_eq!(short[5].start_seconds, 39.0);
        assert!(short.iter().all(|window| {
            window.duration_seconds <= ENHANCED_SAMPLE_SECONDS
                && window.start_seconds >= 0.0
                && window.start_seconds + window.duration_seconds <= 47.0
        }));

        let long = plan_enhanced_discovery_windows(136.0);
        assert_eq!(long.len(), MAX_ENHANCED_DISCOVERY_SIGNATURES);
        assert_eq!(long.first().unwrap().start_seconds, 0.0);
        assert_eq!(long.last().unwrap().start_seconds, 128.0);
        assert!(long
            .windows(2)
            .all(|pair| pair[0].start_seconds < pair[1].start_seconds));
    }

    #[test]
    fn acoustic_activity_regions_are_sustained_bridged_and_bounded() {
        let mut envelope = vec![0.002_f32; 48];
        envelope[8..20].fill(0.22);
        envelope[22..32].fill(0.24);
        // This bright but too-short tail must not become a stable region.
        envelope[38..47].fill(0.8);

        let regions = derive_acoustic_activity_regions(&envelope, 12.0);

        assert_eq!(regions.len(), 1);
        let region = &regions[0];
        assert!((region.start_seconds - 2.0).abs() < 0.001);
        assert!((region.end_seconds - 8.0).abs() < 0.001);
        assert!((0.0..=1.0).contains(&region.activity_level));
        assert!(region.activity_level > 0.2);
    }

    #[test]
    fn map_aware_discovery_prioritizes_distinct_regions_with_bounded_windows() {
        let regions = vec![
            AcousticActivityRegion {
                start_seconds: 16.0,
                end_seconds: 32.0,
                activity_level: 0.9,
            },
            AcousticActivityRegion {
                start_seconds: 88.0,
                end_seconds: 104.0,
                activity_level: 0.8,
            },
        ];

        let windows = plan_enhanced_discovery_windows_for_map(136.0, &regions);

        assert!(windows.len() <= MAX_ENHANCED_DISCOVERY_SIGNATURES);
        assert!(windows
            .iter()
            .any(|window| (window.start_seconds - 20.0).abs() < 0.001));
        assert!(windows
            .iter()
            .any(|window| (window.start_seconds - 92.0).abs() < 0.001));
        assert!(windows.iter().all(|window| {
            window.start_seconds >= 0.0
                && window.duration_seconds > 0.0
                && window.duration_seconds <= ENHANCED_SAMPLE_SECONDS
                && window.start_seconds + window.duration_seconds <= 136.0
        }));
        assert!(windows.windows(2).all(|pair| {
            pair[1].start_seconds - pair[0].start_seconds >= ENHANCED_WINDOW_START_EPSILON_SECONDS
        }));
    }

    #[test]
    fn local_activity_without_contrast_uses_the_stable_discovery_fallback() {
        let uniform = vec![0.12_f32; 64];
        let regions = derive_acoustic_activity_regions(&uniform, 32.0);
        assert!(regions.is_empty());

        let fallback = plan_enhanced_discovery_windows(136.0);
        assert_eq!(
            plan_enhanced_discovery_windows_for_map(136.0, &regions),
            fallback
        );
        assert_eq!(
            plan_enhanced_discovery_windows_for_map(136.0, &[]),
            plan_enhanced_discovery_windows(136.0)
        );
    }

    #[test]
    fn targeted_enhanced_sweep_covers_a_bounded_selected_range() {
        let windows = plan_enhanced_targeted_windows(&SampleWindow {
            start_seconds: 20.0,
            duration_seconds: 28.0,
        });
        let starts = windows
            .iter()
            .map(|window| window.start_seconds)
            .collect::<Vec<_>>();

        assert_eq!(starts, vec![20.0, 28.0, 36.0, 40.0]);
        assert!(windows.iter().all(|window| window.duration_seconds == 8.0));
        assert_eq!(
            time_range_for_enhanced_window(&windows[3]).end_seconds,
            48.0
        );
    }

    #[test]
    fn confidence_mapping_is_deterministic() {
        assert_eq!(confidence_for_score(0.86), "High confidence");
        assert_eq!(confidence_for_score(0.65), "Possible match");
        assert_eq!(confidence_for_score(0.64), "Needs review");
    }

    #[test]
    fn normalization_consolidates_case_and_punctuation() {
        assert_eq!(
            normalized_track_key("Moon-light!", "Kali Uchis"),
            normalized_track_key("moonlight", "KALI UCHIS")
        );
        assert_ne!(
            normalized_track_key("AB", "C"),
            normalized_track_key("A", "BC")
        );
    }

    #[test]
    fn exact_itunes_title_and_artist_match_wins_for_preview() {
        let results = vec![
            ItunesSearchResult {
                track_name: Some("Deva Entry".to_string()),
                artist_name: Some("Another Artist".to_string()),
                preview_url: Some("https://audio.example.test/other.m4a".to_string()),
                track_view_url: Some("https://music.example.test/other".to_string()),
            },
            ItunesSearchResult {
                track_name: Some("Deva Entry".to_string()),
                artist_name: Some("Vishnu Vijay".to_string()),
                preview_url: Some("https://audio.example.test/exact.m4a".to_string()),
                track_view_url: Some("https://music.example.test/exact".to_string()),
            },
        ];

        let preview = preview_from_itunes_results("Deva Entry", "Vishnu Vijay", &results)
            .expect("the exact pair should be previewable");
        assert_eq!(
            preview.preview_url.as_deref(),
            Some("https://audio.example.test/exact.m4a")
        );
        assert_eq!(
            preview.track_view_url.as_deref(),
            Some("https://music.example.test/exact")
        );
    }

    #[test]
    fn ambiguous_title_only_itunes_results_are_rejected() {
        let results = vec![
            ItunesSearchResult {
                track_name: Some("Moonlight".to_string()),
                artist_name: Some("Artist One".to_string()),
                preview_url: Some("https://audio.example.test/one.m4a".to_string()),
                track_view_url: Some("https://music.example.test/one".to_string()),
            },
            ItunesSearchResult {
                track_name: Some("Moonlight".to_string()),
                artist_name: Some("Artist Two".to_string()),
                preview_url: Some("https://audio.example.test/two.m4a".to_string()),
                track_view_url: Some("https://music.example.test/two".to_string()),
            },
        ];

        assert!(preview_from_itunes_results("Moonlight", "Unknown Artist", &results).is_none());
    }

    #[test]
    fn itunes_preview_requires_valid_https_urls() {
        let insecure_preview = vec![ItunesSearchResult {
            track_name: Some("Udi Udi".to_string()),
            artist_name: Some("Aneesh".to_string()),
            preview_url: Some("http://audio.example.test/preview.m4a".to_string()),
            track_view_url: Some("https://music.example.test/track".to_string()),
        }];
        let malformed_store_link = vec![ItunesSearchResult {
            track_name: Some("Udi Udi".to_string()),
            artist_name: Some("Aneesh".to_string()),
            preview_url: Some("https://audio.example.test/preview.m4a".to_string()),
            track_view_url: Some("https://".to_string()),
        }];

        assert!(preview_from_itunes_results("Udi Udi", "Aneesh", &insecure_preview).is_none());
        assert!(preview_from_itunes_results("Udi Udi", "Aneesh", &malformed_store_link).is_none());
    }

    #[test]
    fn scan_results_only_serialize_compact_runtime_map_metadata() {
        let candidate = CandidateTrack {
            id: "candidate".to_string(),
            title: "Local title".to_string(),
            artist: "Local artist".to_string(),
            score: 1.0,
            confidence: "High confidence".to_string(),
            timestamps: vec![0.0],
            musicbrainz_id: None,
            artwork_url: None,
            lookup_source: "Test lookup".to_string(),
        };
        let result = ScanResult {
            source: video_info(&test_source(8.0)),
            samples: Vec::new(),
            candidates: vec![candidate],
            recognition_status: "complete".to_string(),
            message: "Local result".to_string(),
            enhanced_recognition_attempted: false,
            enhanced_signature_submitted: false,
            enhanced_signature_ranges: Vec::new(),
            soundtrack_map: Some(SoundtrackMap {
                available: true,
                activity_regions: vec![AcousticActivityRegion {
                    start_seconds: 8.0,
                    end_seconds: 16.0,
                    activity_level: 0.42,
                }],
                recommended_ranges: vec![TimeRange {
                    start_seconds: 8.0,
                    end_seconds: 16.0,
                }],
            }),
            temporary_artifacts: "not-created".to_string(),
        };

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(serialized.contains("soundtrackMap"));
        assert!(serialized.contains("activityRegions"));
        assert!(serialized.contains("recommendedRanges"));
        assert!(!serialized.contains("previewUrl"));
        assert!(!serialized.contains("trackViewUrl"));
        assert!(!serialized.contains("providerPayload"));
        assert!(!serialized.contains("canonicalPath"));
        assert!(!serialized.contains("pcmBytes"));
        assert!(!serialized.contains("rawEnvelope"));
        assert!(!serialized.contains("fingerprintData"));
        assert!(!serialized.contains("signaturePayload"));
    }

    #[test]
    fn targeted_or_legacy_scan_results_omit_the_runtime_soundtrack_map() {
        let result = ScanResult {
            source: video_info(&test_source(8.0)),
            samples: Vec::new(),
            candidates: Vec::new(),
            recognition_status: "complete".to_string(),
            message: "Local result".to_string(),
            enhanced_recognition_attempted: false,
            enhanced_signature_submitted: false,
            enhanced_signature_ranges: Vec::new(),
            soundtrack_map: None,
            temporary_artifacts: "not-created".to_string(),
        };

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("soundtrackMap"));
    }

    #[test]
    fn candidate_deduplication_preserves_distinct_tracks_and_all_moments() {
        let candidate = |title: &str, artist: &str, score: f64, timestamp: f64| CandidateTrack {
            id: format!("{title}-{timestamp}"),
            title: title.to_string(),
            artist: artist.to_string(),
            score,
            confidence: confidence_for_score(score).to_string(),
            timestamps: vec![timestamp],
            musicbrainz_id: None,
            artwork_url: None,
            lookup_source: "Test lookup".to_string(),
        };

        let tracks = deduplicate_candidates(vec![
            candidate("Opening", "Artist", 1.0, 32.0),
            candidate("Closing", "Artist", 1.0, 16.0),
            candidate("Opening", "Artist", 1.0, 0.0),
        ]);

        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Opening");
        assert_eq!(tracks[0].timestamps, vec![0.0, 32.0]);
        assert_eq!(tracks[1].title, "Closing");
        assert_eq!(tracks[1].timestamps, vec![16.0]);
    }

    #[test]
    #[ignore = "requires locally installed FFmpeg and Chromaprint"]
    fn local_tools_extract_and_fingerprint_without_changing_the_source() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("soniq-media-test-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();

        let source = root.join("generated-source.mp4");
        let ffmpeg = binary_path("ffmpeg").unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut generate = Command::new(&ffmpeg);
        generate
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x90:rate=12",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "10",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-shortest",
                "-y",
            ])
            .arg(&source);
        run_status(generate, &cancellation).unwrap();

        let source_size = fs::metadata(&source).unwrap().len();
        let duration = probe_duration(&source).unwrap();
        let window = plan_sample_windows(duration).remove(0);
        let audio = root.join("temporary-sample.wav");
        extract_audio_sample(&ffmpeg, &source, &window, &audio, &cancellation).unwrap();
        let fingerprint =
            create_fingerprint(&binary_path("fpcalc").unwrap(), &audio, &cancellation).unwrap();
        let waveform_audio = root.join("temporary-waveform.pcm");
        extract_waveform_audio_sample(&ffmpeg, &source, &window, &waveform_audio, &cancellation)
            .unwrap();
        let waveform =
            calculate_waveform_envelope(&fs::read(&waveform_audio).unwrap(), 24).unwrap();

        assert!(!fingerprint.fingerprint.is_empty());
        assert_eq!(waveform.len(), 24);
        assert!(waveform
            .iter()
            .all(|amplitude| (0.0..=1.0).contains(amplitude)));
        assert_eq!(fs::metadata(&source).unwrap().len(), source_size);
        fs::remove_file(&audio).unwrap();
        fs::remove_file(&waveform_audio).unwrap();
        assert!(!audio.exists());
        assert!(!waveform_audio.exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
