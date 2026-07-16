use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::models::CANCELLATION_MESSAGE;

pub(crate) fn temporary_scan_directory() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "SonIQ could not prepare temporary scan storage.".to_string())?
        .as_nanos();
    let directory = env::temp_dir().join(format!("soniq-scan-{}-{nonce}", std::process::id()));
    fs::create_dir(&directory)
        .map_err(|_| "SonIQ could not create temporary local scan storage.".to_string())?;
    Ok(directory)
}

pub(crate) fn finish_temporary_work<T>(
    result: Result<T, String>,
    work_dir: &Path,
    artifact_label: &str,
) -> Result<T, String> {
    let cleanup_result = fs::remove_dir_all(work_dir)
        .map_err(|_| format!("SonIQ could not clear its temporary {artifact_label}."));

    match (result, cleanup_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(result), Ok(())) => Ok(result),
    }
}

pub(crate) fn ensure_not_cancelled(cancellation: &AtomicBool) -> Result<(), String> {
    if cancellation.load(Ordering::SeqCst) {
        Err(CANCELLATION_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn run_status(
    mut command: Command,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "SonIQ could not start the local media tool.".to_string())?;

    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLATION_MESSAGE.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err("The local media tool could not process this sample.".to_string())
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("SonIQ could not read the local media tool state.".to_string()),
        }
    }
}

pub(crate) fn run_capture(
    command: Command,
    cancellation: &Arc<AtomicBool>,
) -> Result<String, String> {
    run_capture_inner(command, cancellation, None, "")
}

pub(crate) fn run_capture_with_timeout(
    command: Command,
    cancellation: &Arc<AtomicBool>,
    timeout: Duration,
    timeout_message: &str,
) -> Result<String, String> {
    run_capture_inner(command, cancellation, Some(timeout), timeout_message)
}

fn run_capture_inner(
    mut command: Command,
    cancellation: &Arc<AtomicBool>,
    timeout: Option<Duration>,
    timeout_message: &str,
) -> Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "SonIQ could not start the local media tool.".to_string())?;
    let started_at = Instant::now();

    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLATION_MESSAGE.to_string());
        }
        if timeout.is_some_and(|limit| started_at.elapsed() >= limit) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(timeout_message.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_string(&mut output).map_err(|_| {
                        "SonIQ could not read the local media tool output.".to_string()
                    })?;
                }
                return Ok(output);
            }
            Ok(Some(_)) => {
                return Err("The local media tool could not process this video.".to_string())
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("SonIQ could not read the local media tool state.".to_string()),
        }
    }
}
