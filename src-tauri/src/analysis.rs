use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::AppHandle;

use crate::{
    media::{extract_acoustic_activity_audio_sample, extract_waveform_audio_sample},
    models::{
        AcousticActivityRegion, InspectedSource, SampleWindow, SoundtrackMap, WaveformEnvelope,
        ACOUSTIC_MAP_BUCKETS_PER_SECOND, ACOUSTIC_MAP_SAMPLE_RATE,
        MAX_ACOUSTIC_ACTIVITY_GAP_SECONDS, MAX_ACOUSTIC_ACTIVITY_REGIONS, MAX_ACOUSTIC_MAP_BUCKETS,
        MAX_WAVEFORM_BUCKETS, MAX_WAVEFORM_DURATION_SECONDS, MIN_ACOUSTIC_ACTIVITY_CONTRAST,
        MIN_ACOUSTIC_ACTIVITY_LEVEL, MIN_ACOUSTIC_ACTIVITY_REGION_SECONDS,
        WAVEFORM_BUCKETS_PER_SECOND, WAVEFORM_SAMPLE_RATE,
    },
    planning::acoustic_activity_region_weight,
    process::{ensure_not_cancelled, finish_temporary_work, temporary_scan_directory},
    progress::emit_progress,
    runtime::binary_path,
    source::video_info,
};

/**
 * Build display-only activity evidence before normal enhanced planning. The
 * PCM envelope exists only in the current temporary scan directory and is
 * intentionally reduced to compact region summaries before returning.
 */
pub(crate) fn derive_local_soundtrack_map(
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
pub(crate) fn derive_acoustic_activity_regions(
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

pub(crate) fn generate_waveform_envelope_for_range(
    app: &AppHandle,
    source: InspectedSource,
    range: SampleWindow,
    cancellation: Arc<AtomicBool>,
) -> Result<WaveformEnvelope, String> {
    ensure_not_cancelled(&cancellation)?;
    let ffmpeg = binary_path(app, "ffmpeg")?;
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

pub(crate) fn waveform_bucket_count(duration_seconds: f64) -> usize {
    ((duration_seconds * WAVEFORM_BUCKETS_PER_SECOND).ceil() as usize)
        .clamp(1, MAX_WAVEFORM_BUCKETS)
}

pub(crate) fn calculate_waveform_envelope(
    pcm: &[u8],
    bucket_count: usize,
) -> Result<Vec<f32>, String> {
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
