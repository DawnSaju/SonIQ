use std::{
    sync::{atomic::AtomicBool, Arc},
    thread,
    time::{Duration, Instant},
};

use crate::process::ensure_not_cancelled;

pub(crate) fn wait_with_cancellation(
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

pub(crate) fn confidence_for_score(score: f64) -> &'static str {
    if score >= 0.86 {
        "High confidence"
    } else if score >= 0.65 {
        "Possible match"
    } else {
        "Needs review"
    }
}

pub(crate) fn normalized_track_key(title: &str, artist: &str) -> String {
    format!(
        "{}::{}",
        normalized_track_component(title),
        normalized_track_component(artist)
    )
}

pub(crate) fn normalized_track_component(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

pub(crate) fn format_duration(duration_seconds: f64) -> String {
    let rounded = duration_seconds.max(0.0).round() as u64;
    let minutes = rounded / 60;
    let seconds = rounded % 60;
    format!("{minutes:02}:{seconds:02}")
}
