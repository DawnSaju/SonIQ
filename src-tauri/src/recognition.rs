use std::{
    collections::HashMap,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::AppHandle;

use crate::{
    models::{
        AcoustIdResponse, CandidateTrack, EnhancedRecognitionOutcome, EnhancedRecognitionResponse,
        FpcalcOutput, ItunesSearchResponse, ItunesSearchResult, TrackPreview, CANCELLATION_MESSAGE,
        ENHANCED_LOOKUP_TIMEOUT, MAX_PREVIEW_DISPLAY_TEXT_LENGTH, PREVIEW_LOOKUP_TIMEOUT,
    },
    process::run_capture_with_timeout,
    runtime::enhanced_recognition_command,
    util::{confidence_for_score, normalized_track_component, normalized_track_key},
};

pub(crate) fn lookup_acoustid(
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

pub(crate) fn no_track_preview() -> TrackPreview {
    TrackPreview {
        preview_url: None,
        track_view_url: None,
        attribution: "Provided courtesy of iTunes",
    }
}

pub(crate) fn validate_preview_display_text(value: &str, label: &str) -> Result<String, String> {
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
pub(crate) fn lookup_itunes_track_preview(title: &str, artist: &str) -> TrackPreview {
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

pub(crate) fn preview_from_itunes_results(
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

pub(crate) fn lookup_enhanced_recognition(
    app: &AppHandle,
    audio_path: &Path,
    timestamp_seconds: f64,
    cancellation: &Arc<AtomicBool>,
) -> Result<EnhancedRecognitionOutcome, String> {
    let mut command = enhanced_recognition_command(app)?;
    command.arg(audio_path);

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
            "Enhanced recognition is unavailable right now. SonIQ kept the completed local results."
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
                    "Enhanced recognition returned an unreadable response. SonIQ kept the completed local results."
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
                "Enhanced recognition returned an incomplete response. SonIQ kept the completed local results."
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

pub(crate) fn deduplicate_candidates(candidates: Vec<CandidateTrack>) -> Vec<CandidateTrack> {
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
