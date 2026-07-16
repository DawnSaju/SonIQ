use std::{
    path::Path,
    process::Command,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::AppHandle;

use crate::{
    models::{
        FpcalcOutput, SampleWindow, ACOUSTIC_MAP_SAMPLE_RATE, CANCELLATION_MESSAGE,
        ENHANCED_SAMPLE_SECONDS, WAVEFORM_SAMPLE_RATE,
    },
    process::{run_capture, run_status},
    runtime::binary_path,
};

pub(crate) fn probe_duration(app: &AppHandle, source: &Path) -> Result<f64, String> {
    let ffprobe = binary_path(app, "ffprobe")?;
    probe_duration_with(&ffprobe, source)
}

pub(crate) fn probe_duration_with(ffprobe: &Path, source: &Path) -> Result<f64, String> {
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

pub(crate) fn extract_audio_sample(
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

pub(crate) fn extract_enhanced_audio_sample(
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

pub(crate) fn extract_waveform_audio_sample(
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

pub(crate) fn extract_acoustic_activity_audio_sample(
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

pub(crate) fn create_fingerprint(
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
