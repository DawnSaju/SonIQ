use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::AppHandle;

use crate::{
    media::probe_duration,
    models::{
        InspectedSource, SampleWindow, VideoInfo, MAX_CUE_SHEET_BYTES,
        MAX_WAVEFORM_DURATION_SECONDS, TARGETED_RECOVERY_MAX_SECONDS,
        TARGETED_RECOVERY_MIN_SECONDS,
    },
    util::format_duration,
};

pub(crate) fn inspect_source(
    app: &AppHandle,
    source_path: &str,
) -> Result<InspectedSource, String> {
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

    let duration_seconds = probe_duration(app, &canonical_path)?;
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

pub(crate) fn video_info(source: &InspectedSource) -> VideoInfo {
    VideoInfo {
        file_name: source.file_name.clone(),
        duration_seconds: source.duration_seconds,
        duration_label: format_duration(source.duration_seconds),
    }
}

pub(crate) fn validate_waveform_range(
    source: &InspectedSource,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<SampleWindow, String> {
    match (start_seconds, end_seconds) {
        (None, None) if source.duration_seconds <= MAX_WAVEFORM_DURATION_SECONDS => {
            Ok(SampleWindow {
                start_seconds: 0.0,
                duration_seconds: source.duration_seconds,
            })
        }
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

pub(crate) fn validate_targeted_recovery_range(
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

pub(crate) fn validate_source_range(
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

pub(crate) fn validate_cue_sheet_destination(
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
