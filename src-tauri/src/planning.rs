use crate::models::{
    AcousticActivityRegion, SampleWindow, TimeRange, ENHANCED_SAMPLE_SECONDS,
    ENHANCED_WINDOW_START_EPSILON_SECONDS, MAX_ENHANCED_DISCOVERY_SIGNATURES,
    MAX_ENHANCED_TARGETED_SIGNATURES, MIN_WINDOW_SECONDS, TARGET_SAMPLE_SECONDS,
};

pub(crate) fn plan_sample_windows(duration_seconds: f64) -> Vec<SampleWindow> {
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
pub(crate) fn plan_enhanced_discovery_windows(duration_seconds: f64) -> Vec<SampleWindow> {
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
pub(crate) fn plan_enhanced_discovery_windows_for_map(
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

pub(crate) fn acoustic_activity_region_weight(region: &AcousticActivityRegion) -> f32 {
    let duration_weight = (region.end_seconds - region.start_seconds).max(1.0).sqrt() as f32;
    region.activity_level * duration_weight
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
pub(crate) fn plan_enhanced_targeted_windows(window: &SampleWindow) -> Vec<SampleWindow> {
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

pub(crate) fn time_range_for_enhanced_window(window: &SampleWindow) -> TimeRange {
    let duration = window.duration_seconds.clamp(0.0, ENHANCED_SAMPLE_SECONDS);
    TimeRange {
        start_seconds: window.start_seconds,
        end_seconds: window.start_seconds + duration,
    }
}
