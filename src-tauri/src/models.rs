use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

pub(crate) const TARGET_SAMPLE_SECONDS: f64 = 28.0;
pub(crate) const MIN_WINDOW_SECONDS: f64 = 8.0;
pub(crate) const ENHANCED_SAMPLE_SECONDS: f64 = 8.0;
pub(crate) const MAX_ENHANCED_DISCOVERY_SIGNATURES: usize = 6;
pub(crate) const MAX_ENHANCED_TARGETED_SIGNATURES: usize = 4;
pub(crate) const TARGETED_RECOVERY_MIN_SECONDS: f64 = MIN_WINDOW_SECONDS;
pub(crate) const TARGETED_RECOVERY_MAX_SECONDS: f64 = TARGET_SAMPLE_SECONDS;
pub(crate) const MAX_WAVEFORM_DURATION_SECONDS: f64 = 30.0 * 60.0;
pub(crate) const WAVEFORM_SAMPLE_RATE: u32 = 8_000;
pub(crate) const WAVEFORM_BUCKETS_PER_SECOND: f64 = 4.0;
pub(crate) const MAX_WAVEFORM_BUCKETS: usize = 360;
pub(crate) const ACOUSTIC_MAP_SAMPLE_RATE: u32 = 2_000;
pub(crate) const ACOUSTIC_MAP_BUCKETS_PER_SECOND: f64 = 4.0;
pub(crate) const MAX_ACOUSTIC_MAP_BUCKETS: usize = 7_200;
pub(crate) const MAX_ACOUSTIC_ACTIVITY_REGIONS: usize = 12;
pub(crate) const MIN_ACOUSTIC_ACTIVITY_REGION_SECONDS: f64 = 3.0;
pub(crate) const MAX_ACOUSTIC_ACTIVITY_GAP_SECONDS: f64 = 0.75;
pub(crate) const MIN_ACOUSTIC_ACTIVITY_LEVEL: f32 = 0.008;
pub(crate) const MIN_ACOUSTIC_ACTIVITY_CONTRAST: f32 = 0.012;
pub(crate) const ENHANCED_WINDOW_START_EPSILON_SECONDS: f64 = 0.25;
pub(crate) const MAX_CUE_SHEET_BYTES: usize = 1_024 * 1_024;
pub(crate) const ENHANCED_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
pub(crate) const PREVIEW_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
pub(crate) const MAX_PREVIEW_DISPLAY_TEXT_LENGTH: usize = 500;
pub(crate) const LOOKUP_PACING: Duration = Duration::from_millis(350);
pub(crate) const ENHANCED_LOOKUP_PACING: Duration = Duration::from_millis(750);
pub(crate) const CANCELLATION_MESSAGE: &str = "Scan cancelled. Your source video was not changed.";

#[derive(Clone)]
pub(crate) struct InspectedSource {
    pub(crate) canonical_path: PathBuf,
    pub(crate) file_name: String,
    pub(crate) duration_seconds: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoInfo {
    pub(crate) file_name: String,
    pub(crate) duration_seconds: f64,
    pub(crate) duration_label: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanProgress {
    pub(crate) stage: String,
    pub(crate) detail: String,
    pub(crate) completed_samples: usize,
    pub(crate) total_samples: usize,
}

#[derive(Debug, PartialEq, Clone)]
pub(crate) struct SampleWindow {
    pub(crate) start_seconds: f64,
    pub(crate) duration_seconds: f64,
}

#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimeRange {
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

/**
 * Compact, session-only evidence from the local activity pass. It contains no
 * waveform values, PCM, source path, fingerprint, signature, or provider data.
 */
#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoundtrackMap {
    pub(crate) available: bool,
    pub(crate) activity_regions: Vec<AcousticActivityRegion>,
    pub(crate) recommended_ranges: Vec<TimeRange>,
}

#[derive(Debug, PartialEq, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcousticActivityRegion {
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) activity_level: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanSample {
    pub(crate) index: usize,
    pub(crate) timestamp_seconds: f64,
    pub(crate) duration_seconds: f64,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CandidateTrack {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) score: f64,
    pub(crate) confidence: String,
    pub(crate) timestamps: Vec<f64>,
    pub(crate) musicbrainz_id: Option<String>,
    pub(crate) artwork_url: Option<String>,
    pub(crate) lookup_source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    pub(crate) source: VideoInfo,
    pub(crate) samples: Vec<ScanSample>,
    pub(crate) candidates: Vec<CandidateTrack>,
    pub(crate) recognition_status: String,
    pub(crate) message: String,
    pub(crate) enhanced_recognition_attempted: bool,
    pub(crate) enhanced_signature_submitted: bool,
    pub(crate) enhanced_signature_ranges: Vec<TimeRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) soundtrack_map: Option<SoundtrackMap>,
    pub(crate) temporary_artifacts: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WaveformEnvelope {
    pub(crate) source: VideoInfo,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) bucket_duration_seconds: f64,
    pub(crate) amplitudes: Vec<f32>,
}

#[derive(Deserialize)]
pub(crate) struct FpcalcOutput {
    pub(crate) duration: f64,
    pub(crate) fingerprint: String,
}

#[derive(Deserialize)]
pub(crate) struct AcoustIdResponse {
    pub(crate) status: String,
    pub(crate) results: Option<Vec<AcoustIdResult>>,
}

#[derive(Deserialize)]
pub(crate) struct AcoustIdResult {
    pub(crate) score: f64,
    pub(crate) recordings: Option<Vec<AcoustIdRecording>>,
}

#[derive(Deserialize)]
pub(crate) struct AcoustIdRecording {
    pub(crate) id: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) artists: Option<Vec<AcoustIdArtist>>,
}

#[derive(Deserialize)]
pub(crate) struct AcoustIdArtist {
    pub(crate) name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct EnhancedRecognitionResponse {
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    #[serde(rename = "artworkUrl")]
    pub(crate) artwork_url: Option<String>,
}

pub(crate) struct EnhancedRecognitionOutcome {
    pub(crate) candidate: Option<CandidateTrack>,
    pub(crate) signature_submitted: bool,
    pub(crate) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItunesSearchResponse {
    pub(crate) results: Option<Vec<ItunesSearchResult>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItunesSearchResult {
    pub(crate) track_name: Option<String>,
    pub(crate) artist_name: Option<String>,
    pub(crate) preview_url: Option<String>,
    pub(crate) track_view_url: Option<String>,
}

/**
 * Runtime-only promotional preview data. It deliberately has no path into a
 * CandidateTrack, ScanResult, or the persisted soundtrack model.
 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackPreview {
    pub(crate) preview_url: Option<String>,
    pub(crate) track_view_url: Option<String>,
    pub(crate) attribution: &'static str,
}

// The standard fingerprint path is useful when a person has explicitly
// configured AcoustID, but it is not a prerequisite for the enhanced default
// path. Keeping it as one prepared capability prevents a missing optional
// tool from stopping an otherwise viable scan.
pub(crate) struct StandardRecognitionPipeline {
    pub(crate) fpcalc: PathBuf,
    pub(crate) api_key: Option<String>,
    pub(crate) lookup_client: Option<reqwest::blocking::Client>,
}
