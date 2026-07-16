use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    thread,
};

use tauri::AppHandle;

use crate::{
    analysis::derive_local_soundtrack_map,
    media::{create_fingerprint, extract_audio_sample, extract_enhanced_audio_sample},
    models::{
        InspectedSource, SampleWindow, ScanResult, ScanSample, SoundtrackMap, CANCELLATION_MESSAGE,
        ENHANCED_LOOKUP_PACING, LOOKUP_PACING,
    },
    planning::{
        plan_enhanced_discovery_windows_for_map, plan_enhanced_targeted_windows,
        plan_sample_windows, time_range_for_enhanced_window,
    },
    process::{ensure_not_cancelled, finish_temporary_work, temporary_scan_directory},
    progress::emit_progress,
    recognition::{deduplicate_candidates, lookup_acoustid, lookup_enhanced_recognition},
    runtime::{binary_path, prepare_standard_recognition_pipeline},
    source::video_info,
    util::{format_duration, wait_with_cancellation},
};

pub(crate) fn scan_source(
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

    let ffmpeg = binary_path(app, "ffmpeg")?;
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

    let ffmpeg = binary_path(app, "ffmpeg")?;
    let work_dir = temporary_scan_directory()?;

    let scan_result = scan_source_in_directory(
        app,
        &source,
        &windows,
        &enhanced_windows,
        None,
        &ffmpeg,
        &work_dir,
        &cancellation,
        enhanced_recognition,
    );
    finish_temporary_work(scan_result, &work_dir, "scan files")
}

pub(crate) fn scan_targeted_recovery(
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
    work_dir: &Path,
    cancellation: &Arc<AtomicBool>,
    enhanced_recognition: bool,
) -> Result<ScanResult, String> {
    let standard_pipeline = prepare_standard_recognition_pipeline(app, enhanced_recognition)?;
    let standard_has_api_key = standard_pipeline
        .as_ref()
        .and_then(|pipeline| pipeline.api_key.as_ref())
        .is_some();
    let standard_sample_count = standard_pipeline.as_ref().map_or(0, |_| windows.len());
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

    if let Some(pipeline) = standard_pipeline.as_ref() {
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

            let fingerprint = match create_fingerprint(&pipeline.fpcalc, &audio_path, cancellation)
            {
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

            let mut sample_message = if standard_has_api_key {
                "Fingerprint created locally.".to_string()
            } else {
                "Fingerprint created locally. Recognition is not configured yet.".to_string()
            };

            if let (Some(key), Some(client)) =
                (pipeline.api_key.as_deref(), pipeline.lookup_client.as_ref())
            {
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
                    app,
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
    let completed_enhanced_check = enhanced_signature_submitted;
    let recognition_status = if successful_samples == 0 && !completed_enhanced_check {
        "pipelineFailed"
    } else if !standard_has_api_key && !enhanced_recognition {
        "notConfigured"
    } else if lookup_failed || enhanced_failed {
        "partialFailure"
    } else {
        "complete"
    }
    .to_string();

    let message = match recognition_status.as_str() {
        "pipelineFailed" if enhanced_recognition => {
            "SonIQ could not complete a usable local recognition check for this video.".to_string()
        }
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
        _ if candidates.is_empty() => "No reliable matches were returned for these local checks.".to_string(),
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
