use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn setup_mac_tray(callback: extern "C" fn(*const c_char));
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

pub fn init(app: AppHandle) {
    APP_HANDLE.set(app).ok();
    
    #[cfg(target_os = "macos")]
    unsafe {
        setup_mac_tray(on_file_dropped);
    }
}
