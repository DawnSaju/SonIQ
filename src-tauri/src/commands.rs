use std::{fs, io::Write, sync::Arc};

use tauri::{AppHandle, State};

use crate::{
    analysis::generate_waveform_envelope_for_range,
    models::{ScanResult, TrackPreview, VideoInfo, WaveformEnvelope},
    progress::emit_progress,
    recognition::{lookup_itunes_track_preview, no_track_preview, validate_preview_display_text},
    scan::{scan_source, scan_targeted_recovery},
    source::{
        inspect_source, validate_cue_sheet_destination, validate_targeted_recovery_range,
        validate_waveform_range, video_info,
    },
    state::ScanController,
    util::format_duration,
};

#[tauri::command]
pub(crate) fn inspect_video(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
) -> Result<VideoInfo, String> {
    let source = inspect_source(&app, &source_path)?;
    scan_controller.approve(source.canonical_path.clone());
    Ok(video_info(&source))
}

#[tauri::command]
pub(crate) async fn run_local_scan(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let source = inspect_source(&app, &source_path)?;
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
pub(crate) async fn generate_waveform_envelope(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<WaveformEnvelope, String> {
    let source = inspect_source(&app, &source_path)?;
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
pub(crate) async fn run_targeted_recovery(
    app: AppHandle,
    scan_controller: State<'_, ScanController>,
    source_path: String,
    start_seconds: f64,
    end_seconds: f64,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let source = inspect_source(&app, &source_path)?;
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
pub(crate) async fn lookup_track_preview(
    title: String,
    artist: String,
) -> Result<TrackPreview, String> {
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
pub(crate) fn cancel_active_scan(scan_controller: State<'_, ScanController>) -> bool {
    scan_controller.cancel()
}

#[tauri::command]
pub(crate) fn cancel_active_waveform(scan_controller: State<'_, ScanController>) -> bool {
    scan_controller.cancel_waveform()
}

#[tauri::command]
pub(crate) fn save_cue_sheet(destination_path: String, content: String) -> Result<(), String> {
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

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn create_bookmark(path: String) -> Result<String, String> {
    use base64::prelude::*;
    use objc2_foundation::{NSString, NSURLBookmarkCreationOptions, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(&path));

    let bookmark = url
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::empty(),
            None,
            None,
        )
        .map_err(|e| format!("SonIQ could not secure a bookmark for that file: {:?}", e))?;

    let bytes = bookmark.to_vec();
    Ok(BASE64_STANDARD.encode(bytes))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn create_bookmark(path: String) -> Result<String, String> {
    Ok(path)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn resolve_bookmark(bookmark_base64: String) -> Result<String, String> {
    use base64::prelude::*;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSURLBookmarkResolutionOptions, NSURL};

    let decoded = BASE64_STANDARD
        .decode(&bookmark_base64)
        .map_err(|_| "SonIQ could not read that bookmark.".to_string())?;

    let data = NSData::from_vec(decoded);

    let mut is_stale: Bool = Bool::NO;
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &data,
            NSURLBookmarkResolutionOptions::WithoutUI,
            None,
            &mut is_stale as *mut _,
        )
        .map_err(|e| format!("SonIQ could not reconnect to that file: {:?}", e))?
    };

    let path = url
        .path()
        .ok_or_else(|| "The reconnected file does not have a valid local path.".to_string())?;
    Ok(path.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn resolve_bookmark(bookmark_base64: String) -> Result<String, String> {
    Ok(bookmark_base64)
}
