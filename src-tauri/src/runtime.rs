use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::models::StandardRecognitionPipeline;

pub(crate) fn prepare_standard_recognition_pipeline(
    app: &AppHandle,
    enhanced_recognition: bool,
) -> Result<Option<StandardRecognitionPipeline>, String> {
    let api_key = env::var("SONIQ_ACOUSTID_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty());

    // Enhanced recognition is the default release path. Do not require an
    // optional AcoustID key or Chromaprint installation before it can run.
    if enhanced_recognition && api_key.is_none() {
        return Ok(None);
    }

    let fpcalc = match binary_path(app, "fpcalc") {
        Ok(path) => path,
        Err(_) if enhanced_recognition => return Ok(None),
        Err(error) => return Err(error),
    };

    let lookup_client = match api_key.as_ref() {
        Some(_) => match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
        {
            Ok(client) => Some(client),
            Err(_) if enhanced_recognition => return Ok(None),
            Err(_) => return Err("SonIQ could not prepare the recognition client.".to_string()),
        },
        None => None,
    };

    Ok(Some(StandardRecognitionPipeline {
        fpcalc,
        api_key,
        lookup_client,
    }))
}

pub(crate) fn enhanced_recognition_command(app: &AppHandle) -> Result<Command, String> {
    if let Some(sidecar) = bundled_runtime_binary(app, "soniq-recognition") {
        return Ok(Command::new(sidecar));
    }

    let node = host_binary_path("node").map_err(|_| {
        "Enhanced recognition needs its packaged runtime. For source development, install Node.js and run SonIQ with npm run tauri dev."
            .to_string()
    })?;
    let script = development_enhanced_recognition_script_path()?;
    let mut command = Command::new(node);
    command.arg(script);
    Ok(command)
}

fn development_enhanced_recognition_script_path() -> Result<PathBuf, String> {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "SonIQ could not locate the enhanced-recognition adapter.".to_string())?;
    let script = workspace_root.join("scripts/recognition-adapter.cjs");
    if script.is_file() {
        Ok(script)
    } else {
        Err("Enhanced recognition is not installed in this SonIQ workspace.".to_string())
    }
}

pub(crate) fn binary_path(app: &AppHandle, binary: &str) -> Result<PathBuf, String> {
    bundled_runtime_binary(app, binary)
        .or_else(|| host_binary_path(binary).ok())
        .ok_or_else(|| {
            format!(
                "SonIQ could not find its packaged {binary} runtime or a local copy. For source development, install the local media prerequisites with: brew install ffmpeg chromaprint"
            )
        })
}

fn bundled_runtime_binary(app: &AppHandle, binary: &str) -> Option<PathBuf> {
    let target = release_runtime_target()?;
    let relative_path = PathBuf::from("release-runtime").join(target).join(binary);
    app.path()
        .resolve(relative_path, BaseDirectory::Resource)
        .ok()
        .filter(|path| path.is_file())
}

fn release_runtime_target() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("aarch64-apple-darwin");
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("x86_64-apple-darwin");
    }

    #[allow(unreachable_code)]
    None
}

pub(crate) fn host_binary_path(binary: &str) -> Result<PathBuf, String> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .map(|directory| directory.join(binary))
                .collect()
        })
        .unwrap_or_default();
    paths.extend([
        PathBuf::from(format!("/opt/homebrew/bin/{binary}")),
        PathBuf::from(format!("/usr/local/bin/{binary}")),
        PathBuf::from(format!("/opt/local/bin/{binary}")),
        PathBuf::from(format!("/usr/bin/{binary}")),
    ]);

    paths
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("SonIQ could not find {binary} on this Mac."))
}
