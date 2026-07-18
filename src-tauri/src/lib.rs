mod analysis;
mod commands;
mod media;
mod models;
mod planning;
mod process;
mod progress;
mod recognition;
mod runtime;
mod scan;
mod source;
mod state;
mod util;

use state::ScanController;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(ScanController::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::inspect_video,
            commands::run_local_scan,
            commands::generate_waveform_envelope,
            commands::run_targeted_recovery,
            commands::lookup_track_preview,
            commands::save_cue_sheet,
            commands::cancel_active_scan,
            commands::cancel_active_waveform,
            commands::create_bookmark,
            commands::resolve_bookmark,
            media::fetch_spotify
        ])
        .run(tauri::generate_context!())
        .expect("error while running SonIQ");
}

#[cfg(test)]
mod tests;
