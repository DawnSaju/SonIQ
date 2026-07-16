#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cpus } from "node:os";

const FFMPEG_VERSION = "8.0.1";
const SOURCE_SHA256 =
  "05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41";
const SOURCE_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const VALID_ARGUMENTS = new Set(["--force"]);
const args = process.argv.slice(2);

if (args.some((argument) => !VALID_ARGUMENTS.has(argument))) {
  fail("Usage: node scripts/build-media-tools.mjs [--force]");
}

if (process.platform !== "darwin") {
  fail("This builder only runs on macOS.");
}

const architecture = architectureFor(process.arch);
const targetTriple =
  architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const minimumMacOS = architecture === "arm64" ? "11.0" : "10.15";
const force = args.includes("--force");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const runtimeRoot = join(
  repositoryRoot,
  "src-tauri",
  "resources",
  "release-runtime",
);
const destinationDirectory = join(runtimeRoot, targetTriple);
const releaseArtifactRoot = join(repositoryRoot, "release-artifacts", "ffmpeg-runtime");
const cacheDirectory = join(releaseArtifactRoot, "source-cache");
const buildDirectory = join(releaseArtifactRoot, "build", `ffmpeg-${FFMPEG_VERSION}-${targetTriple}`);
const archivePath = join(cacheDirectory, `ffmpeg-${FFMPEG_VERSION}.tar.xz`);
const metadataPath = join(destinationDirectory, "build-metadata.json");

const systemTools = {
  curl: "/usr/bin/curl",
  tar: "/usr/bin/tar",
  clang: "/usr/bin/clang",
  make: "/usr/bin/make",
  lipo: "/usr/bin/lipo",
  otool: "/usr/bin/otool",
  ar: "/usr/bin/ar",
  ranlib: "/usr/bin/ranlib",
};

for (const [toolName, toolPath] of Object.entries(systemTools)) {
  if (!existsSync(toolPath)) {
    fail(`Required macOS build tool is unavailable: ${toolName} (${toolPath}). Install Xcode Command Line Tools and try again.`);
  }
}

mkdirSync(destinationDirectory, { recursive: true });
cleanupLegacyResourceBuildOutputs();

if (!force && runtimeIsCurrent()) {
  console.log(`FFmpeg ${FFMPEG_VERSION} runtime already exists for ${targetTriple}; nothing to build.`);
  process.exit(0);
}

mkdirSync(cacheDirectory, { recursive: true });
ensureVerifiedArchive();

// A failed build should never be resumed accidentally. This directory is owned
// exclusively by this script and is ignored by Git; published binaries are not
// touched until the newly-built pair has passed verification.
rmSync(buildDirectory, { recursive: true, force: true });
mkdirSync(buildDirectory, { recursive: true });

console.log(`Extracting FFmpeg ${FFMPEG_VERSION} source for ${targetTriple}…`);
run(systemTools.tar, ["-xJf", archivePath, "-C", buildDirectory]);

const sourceDirectory = join(buildDirectory, `ffmpeg-${FFMPEG_VERSION}`);
if (!existsSync(sourceDirectory)) {
  fail("The verified FFmpeg archive did not contain the expected source directory.");
}

const buildEnvironment = {
  ...process.env,
  // Do not let a developer's package-manager paths leak an optional codec or
  // dylib into a supposedly portable release build.
  CPATH: "",
  LIBRARY_PATH: "",
  PKG_CONFIG_PATH: "",
  PKG_CONFIG_LIBDIR: "",
  PKG_CONFIG_SYSROOT_DIR: "",
  DYLD_LIBRARY_PATH: "",
  DYLD_FALLBACK_LIBRARY_PATH: "",
  MACOSX_DEPLOYMENT_TARGET: minimumMacOS,
};

const configureArguments = [
  `--arch=${architecture}`,
  "--target-os=darwin",
  `--cc=${systemTools.clang}`,
  `--ar=${systemTools.ar}`,
  `--ranlib=${systemTools.ranlib}`,
  "--disable-shared",
  "--enable-static",
  "--disable-autodetect",
  "--disable-doc",
  "--disable-debug",
  "--disable-network",
  "--disable-avdevice",
  "--enable-small",
  "--enable-ffmpeg",
  "--enable-ffprobe",
  // SonIQ needs local MP4/MOV/M4V input and PCM audio samples. Keeping this
  // explicit makes the runtime smaller without relying on host-provided code.
  "--enable-protocol=file",
  "--enable-demuxer=mov",
  "--enable-muxer=wav",
  "--enable-muxer=s16le",
  "--enable-encoder=pcm_s16le",
  "--enable-decoder=aac,h264,hevc,mpeg4,mp3,ac3,eac3,alac,flac,opus,vorbis,pcm_s16le,pcm_s16be",
  "--enable-parser=aac,h264,hevc,mpeg4video,mpegaudio,opus,vorbis",
  `--extra-cflags=-arch ${architecture} -mmacosx-version-min=${minimumMacOS}`,
  `--extra-ldflags=-arch ${architecture} -mmacosx-version-min=${minimumMacOS}`,
];

console.log(`Configuring FFmpeg ${FFMPEG_VERSION}…`);
run(join(sourceDirectory, "configure"), configureArguments, {
  cwd: sourceDirectory,
  env: buildEnvironment,
});

const jobs = Math.max(1, Math.min(cpus().length, 8));
console.log(`Building ffmpeg and ffprobe with ${jobs} parallel job${jobs === 1 ? "" : "s"}…`);
run(systemTools.make, [`-j${jobs}`, "ffmpeg", "ffprobe"], {
  cwd: sourceDirectory,
  env: buildEnvironment,
});

const builtFfmpeg = join(sourceDirectory, "ffmpeg");
const builtFfprobe = join(sourceDirectory, "ffprobe");
validateBinary(builtFfmpeg, "ffmpeg");
validateBinary(builtFfprobe, "ffprobe");

installAtomically(builtFfmpeg, join(destinationDirectory, "ffmpeg"));
installAtomically(builtFfprobe, join(destinationDirectory, "ffprobe"));
writeMetadataAtomically();

console.log(`Built portable FFmpeg ${FFMPEG_VERSION} runtime:`);
console.log(`  ${join(destinationDirectory, "ffmpeg")}`);
console.log(`  ${join(destinationDirectory, "ffprobe")}`);

function architectureFor(nodeArchitecture) {
  if (nodeArchitecture === "arm64") {
    return "arm64";
  }

  if (nodeArchitecture === "x64") {
    return "x86_64";
  }

  fail(`Unsupported local macOS architecture: ${nodeArchitecture}. Expected arm64 or x86_64.`);
}

function ensureVerifiedArchive() {
  if (existsSync(archivePath) && sha256(archivePath) === SOURCE_SHA256) {
    console.log(`Using cached, verified FFmpeg ${FFMPEG_VERSION} source archive.`);
    return;
  }

  if (existsSync(archivePath)) {
    console.warn("Discarding cached FFmpeg source archive because its SHA-256 did not match.");
    rmSync(archivePath, { force: true });
  }

  const temporaryArchivePath = `${archivePath}.download-${process.pid}`;
  rmSync(temporaryArchivePath, { force: true });
  console.log(`Downloading pinned FFmpeg ${FFMPEG_VERSION} source from upstream…`);
  run(systemTools.curl, [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--output",
    temporaryArchivePath,
    SOURCE_URL,
  ]);

  const downloadedHash = sha256(temporaryArchivePath);
  if (downloadedHash !== SOURCE_SHA256) {
    rmSync(temporaryArchivePath, { force: true });
    fail(
      `FFmpeg source SHA-256 verification failed. Expected ${SOURCE_SHA256}, received ${downloadedHash}.`,
    );
  }

  renameSync(temporaryArchivePath, archivePath);
}

function runtimeIsCurrent() {
  const ffmpegPath = join(destinationDirectory, "ffmpeg");
  const ffprobePath = join(destinationDirectory, "ffprobe");

  if (!existsSync(metadataPath) || !existsSync(ffmpegPath) || !existsSync(ffprobePath)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      metadata.ffmpegVersion !== FFMPEG_VERSION ||
      metadata.sourceSha256 !== SOURCE_SHA256 ||
      metadata.targetTriple !== targetTriple ||
      metadata.architecture !== architecture
    ) {
      return false;
    }

    validateBinary(ffmpegPath, "ffmpeg");
    validateBinary(ffprobePath, "ffprobe");
    return true;
  } catch {
    return false;
  }
}

function cleanupLegacyResourceBuildOutputs() {
  // Older local runs kept transient source/build folders under the resource
  // directory. Tauri copies that directory recursively, so remove only these
  // known generated folders before every release build.
  for (const legacyDirectory of [join(runtimeRoot, ".source-cache"), join(runtimeRoot, ".build")]) {
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
  removeFinderMetadata(runtimeRoot);
}

function removeFinderMetadata(directory) {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.name === ".DS_Store") {
      rmSync(entryPath, { force: true });
    } else if (entry.isDirectory()) {
      removeFinderMetadata(entryPath);
    }
  }
}

function validateBinary(binaryPath, binaryName) {
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    fail(`Expected ${binaryName} binary was not built: ${binaryPath}`);
  }

  chmodSync(binaryPath, 0o755);
  const version = commandOutput(binaryPath, ["-hide_banner", "-version"]);
  if (!version.includes(`${binaryName} version ${FFMPEG_VERSION}`)) {
    fail(`${binaryName} did not report the expected FFmpeg ${FFMPEG_VERSION} version.`);
  }

  const binaryArchitectures = commandOutput(systemTools.lipo, ["-archs", binaryPath])
    .trim()
    .split(/\s+/);
  if (!binaryArchitectures.includes(architecture)) {
    fail(`${binaryName} was not built for ${architecture}. Found: ${binaryArchitectures.join(", ")}.`);
  }

  // A static FFmpeg build should not inherit Homebrew/Cellar dylibs. System
  // Apple libraries are expected and are the only dynamically-linked pieces.
  const linkedLibraries = commandOutput(systemTools.otool, ["-L", binaryPath]);
  if (/\/(?:opt\/homebrew|usr\/local\/(?:Cellar|opt))\//.test(linkedLibraries)) {
    fail(`${binaryName} links to a package-manager dylib; refusing to publish a non-portable runtime.`);
  }
}

function installAtomically(sourcePath, destinationPath) {
  const temporaryDestination = `${destinationPath}.new-${process.pid}`;
  rmSync(temporaryDestination, { force: true });
  copyFileSync(sourcePath, temporaryDestination);
  chmodSync(temporaryDestination, 0o755);
  renameSync(temporaryDestination, destinationPath);
}

function writeMetadataAtomically() {
  const metadata = {
    format: 1,
    ffmpegVersion: FFMPEG_VERSION,
    sourceUrl: SOURCE_URL,
    sourceSha256: SOURCE_SHA256,
    architecture,
    targetTriple,
    builtAt: new Date().toISOString(),
    note: "FFmpeg libraries are linked statically; macOS system libraries remain dynamic.",
  };
  const temporaryMetadataPath = `${metadataPath}.new-${process.pid}`;
  writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(temporaryMetadataPath, metadataPath);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function commandOutput(command, commandArguments) {
  const result = spawnSync(command, commandArguments, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    fail(`Command failed while validating release runtime: ${command} ${commandArguments.join(" ")}\n${output}`);
  }
  return output;
}

function run(command, commandArguments, options = {}) {
  const result = spawnSync(command, commandArguments, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    fail(`Command failed: ${command} ${commandArguments.join(" ")}`);
  }
}

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}
