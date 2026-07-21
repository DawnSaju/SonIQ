use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn setup_mac_tray(
        drop_callback: extern "C" fn(*const c_char),
        click_callback: extern "C" fn(),
        menu_callback: extern "C" fn(*const c_char),
    );
}

#[cfg(target_os = "macos")]
extern "C" fn on_file_dropped(path: *const c_char) {
    if let Ok(c_str) = unsafe { CStr::from_ptr(path) }.to_str() {
        let path_str = c_str.to_string();
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("tray-file-dropped", path_str);
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" fn on_tray_clicked() {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("tray-clicked", ());
    }
}

#[cfg(target_os = "macos")]
extern "C" fn on_menu_action(action: *const c_char) {
    if let Ok(c_str) = unsafe { CStr::from_ptr(action) }.to_str() {
        if c_str == "quit" {
            if let Some(app) = APP_HANDLE.get() {
                app.exit(0);
            } else {
                std::process::exit(0);
            }
        } else if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("tray-menu-clicked", c_str.to_string());
        }
    }
}

pub fn init(app: AppHandle) {
    APP_HANDLE.set(app).ok();

    #[cfg(target_os = "macos")]
    unsafe {
        setup_mac_tray(on_file_dropped, on_tray_clicked, on_menu_action);
    }
}
