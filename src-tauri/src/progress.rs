use tauri::{AppHandle, Emitter};

use crate::models::ScanProgress;

pub(crate) fn emit_progress(
    app: &AppHandle,
    stage: &str,
    detail: &str,
    completed_samples: usize,
    total_samples: usize,
) {
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            stage: stage.to_string(),
            detail: detail.to_string(),
            completed_samples,
            total_samples,
        },
    );
}
