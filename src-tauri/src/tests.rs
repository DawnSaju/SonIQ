use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    analysis::{
        calculate_waveform_envelope, derive_acoustic_activity_regions, waveform_bucket_count,
    },
    commands::save_cue_sheet,
    media::{
        create_fingerprint, extract_audio_sample, extract_waveform_audio_sample,
        probe_duration_with,
    },
    models::{
        AcousticActivityRegion, CandidateTrack, InspectedSource, ItunesSearchResult, SampleWindow,
        ScanResult, SoundtrackMap, TimeRange, ENHANCED_SAMPLE_SECONDS,
        ENHANCED_WINDOW_START_EPSILON_SECONDS, MAX_CUE_SHEET_BYTES,
        MAX_ENHANCED_DISCOVERY_SIGNATURES, MAX_WAVEFORM_BUCKETS, MAX_WAVEFORM_DURATION_SECONDS,
        TARGETED_RECOVERY_MAX_SECONDS, TARGETED_RECOVERY_MIN_SECONDS, TARGET_SAMPLE_SECONDS,
    },
    planning::{
        plan_enhanced_discovery_windows, plan_enhanced_discovery_windows_for_map,
        plan_enhanced_targeted_windows, plan_sample_windows, time_range_for_enhanced_window,
    },
    process::{finish_temporary_work, run_status},
    recognition::{deduplicate_candidates, preview_from_itunes_results},
    runtime::host_binary_path,
    source::{
        validate_cue_sheet_destination, validate_targeted_recovery_range, validate_waveform_range,
        video_info,
    },
    state::ScanController,
    util::{confidence_for_score, normalized_track_key},
};

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
    assert!(
        validate_targeted_recovery_range(&source, 0.0, TARGETED_RECOVERY_MAX_SECONDS + 0.1)
            .is_err()
    );
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
        window.start_seconds >= 0.0 && window.start_seconds + window.duration_seconds <= duration
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
    let ffmpeg = host_binary_path("ffmpeg").unwrap();
    let ffprobe = host_binary_path("ffprobe").unwrap();
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
    let duration = probe_duration_with(&ffprobe, &source).unwrap();
    let window = plan_sample_windows(duration).remove(0);
    let audio = root.join("temporary-sample.wav");
    extract_audio_sample(&ffmpeg, &source, &window, &audio, &cancellation).unwrap();
    let fingerprint =
        create_fingerprint(&host_binary_path("fpcalc").unwrap(), &audio, &cancellation).unwrap();
    let waveform_audio = root.join("temporary-waveform.pcm");
    extract_waveform_audio_sample(&ffmpeg, &source, &window, &waveform_audio, &cancellation)
        .unwrap();
    let waveform = calculate_waveform_envelope(&fs::read(&waveform_audio).unwrap(), 24).unwrap();

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
