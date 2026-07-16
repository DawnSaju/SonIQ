use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default)]
pub(crate) struct ScanController {
    approved_source: Mutex<Option<PathBuf>>,
    active_cancellation: Mutex<Option<Arc<AtomicBool>>>,
    active_waveform_cancellation: Mutex<Option<Arc<AtomicBool>>>,
}

impl ScanController {
    pub(crate) fn approve(&self, source: PathBuf) {
        if let Ok(mut approved) = self.approved_source.lock() {
            *approved = Some(source);
        }
    }

    pub(crate) fn start(&self, source: &Path) -> Result<Arc<AtomicBool>, String> {
        let approved = self
            .approved_source
            .lock()
            .map_err(|_| "SonIQ could not access the selected source.".to_string())?
            .clone();

        if approved.as_deref() != Some(source) {
            return Err("Choose the video again before starting a scan.".to_string());
        }

        let mut active = self
            .active_cancellation
            .lock()
            .map_err(|_| "SonIQ could not start the scan.".to_string())?;

        if active.is_some() {
            return Err("A local scan is already in progress.".to_string());
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub(crate) fn cancel(&self) -> bool {
        let mut cancelled = false;
        if let Ok(active) = self.active_cancellation.lock() {
            if let Some(cancellation) = active.as_ref() {
                cancellation.store(true, Ordering::SeqCst);
                cancelled = true;
            }
        }
        cancelled
    }

    pub(crate) fn clear(&self, completed: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active_cancellation.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, completed))
            {
                *active = None;
            }
        }
    }

    pub(crate) fn start_waveform(&self, source: &Path) -> Result<Arc<AtomicBool>, String> {
        let approved = self
            .approved_source
            .lock()
            .map_err(|_| "SonIQ could not access the selected source.".to_string())?
            .clone();

        if approved.as_deref() != Some(source) {
            return Err("Choose the video again before creating its local moment map.".to_string());
        }

        let mut active = self
            .active_waveform_cancellation
            .lock()
            .map_err(|_| "SonIQ could not start the local waveform task.".to_string())?;

        if let Some(previous) = active.as_ref() {
            previous.store(true, Ordering::SeqCst);
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub(crate) fn cancel_waveform(&self) -> bool {
        if let Ok(active) = self.active_waveform_cancellation.lock() {
            if let Some(cancellation) = active.as_ref() {
                cancellation.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    pub(crate) fn clear_waveform(&self, completed: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active_waveform_cancellation.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, completed))
            {
                *active = None;
            }
        }
    }
}
