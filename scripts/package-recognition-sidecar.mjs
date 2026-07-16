#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const VALID_ARGUMENTS = new Set(["--force"]);
const args = process.argv.slice(2);

if (args.some((argument) => !VALID_ARGUMENTS.has(argument))) {
  fail("Usage: node scripts/package-recognition-sidecar.mjs [--force]");
}

if (process.platform !== "darwin") {
  fail("This packager only runs on macOS.");
}

const architecture = architectureFor(process.arch);
const targetTriple = architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const pkgTarget = architecture === "arm64" ? "node22-macos-arm64" : "node22-macos-x64";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const adapterPath = join(repositoryRoot, "scripts", "recognition-adapter.cjs");
const pkgPath = join(repositoryRoot, "node_modules", ".bin", "pkg");
const runtimeDirectory = join(repositoryRoot, "src-tauri", "resources", "release-runtime", targetTriple);
const outputPath = join(runtimeDirectory, "soniq-recognition");
const temporaryOutputPath = `${outputPath}.new-${process.pid}`;
const cachePath = join(repositoryRoot, "release-artifacts", "pkg-cache");
const force = args.includes("--force");

if (!existsSync(adapterPath)) {
  fail("The SonIQ recognition adapter is missing.");
}

if (!existsSync(pkgPath)) {
  fail("@yao-pkg/pkg is not installed. Run npm ci before packaging a release.");
}

mkdirSync(runtimeDirectory, { recursive: true });
mkdirSync(cachePath, { recursive: true });
cleanupStaleTemporaryOutputs();

if (!force && sidecarIsCurrent()) {
  console.log(`Recognition sidecar already exists for ${targetTriple}; nothing to package.`);
  process.exit(0);
}

rmSync(temporaryOutputPath, { force: true });
console.log(`Packaging SonIQ recognition sidecar for ${pkgTarget}…`);
run(pkgPath, [
  adapterPath,
  "--target",
  pkgTarget,
  "--output",
  temporaryOutputPath,
  "--public-packages",
  "*",
  "--no-dict",
  "*",
], {
  env: {
    ...process.env,
    PKG_CACHE_PATH: cachePath,
  },
});

validateSidecar(temporaryOutputPath);
verifyCodeSignature(temporaryOutputPath);
renameSync(temporaryOutputPath, outputPath);
writeMetadata();

console.log(`Packaged SonIQ recognition sidecar: ${outputPath}`);

function architectureFor(nodeArchitecture) {
  if (nodeArchitecture === "arm64") return "arm64";
  if (nodeArchitecture === "x64") return "x86_64";
  fail(`Unsupported local macOS architecture: ${nodeArchitecture}. Expected arm64 or x86_64.`);
}

function sidecarIsCurrent() {
  const metadataPath = join(runtimeDirectory, "recognition-sidecar.json");
  if (!existsSync(outputPath) || !existsSync(metadataPath)) return false;

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.format !== 1 || metadata.targetTriple !== targetTriple || metadata.pkgTarget !== pkgTarget) {
      return false;
    }
    validateSidecar(outputPath);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleTemporaryOutputs() {
  for (const entry of readdirSync(runtimeDirectory)) {
    if (entry.startsWith("soniq-recognition.new-")) {
      rmSync(join(runtimeDirectory, entry), { force: true });
    }
  }
}

function validateSidecar(binaryPath) {
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    fail(`The packaged recognition sidecar is missing: ${binaryPath}`);
  }

  chmodSync(binaryPath, 0o755);
  const architectures = commandOutput("/usr/bin/lipo", ["-archs", binaryPath]).trim().split(/\s+/);
  if (!architectures.includes(architecture)) {
    fail(`Recognition sidecar was not built for ${architecture}. Found: ${architectures.join(", ")}.`);
  }

  const linkedLibraries = commandOutput("/usr/bin/otool", ["-L", binaryPath]);
  if (/\/(?:opt\/homebrew|usr\/local\/(?:Cellar|opt))\//.test(linkedLibraries)) {
    fail("Recognition sidecar links to a package-manager dylib; refusing to publish a non-portable runtime.");
  }
}

function verifyCodeSignature(binaryPath) {
  run("/usr/bin/codesign", ["--verify", "--strict", binaryPath]);
}

function writeMetadata() {
  const metadataPath = join(runtimeDirectory, "recognition-sidecar.json");
  const temporaryMetadataPath = `${metadataPath}.new-${process.pid}`;
  const metadata = {
    format: 1,
    targetTriple,
    pkgTarget,
    packager: "@yao-pkg/pkg",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(temporaryMetadataPath, metadataPath);
}

function commandOutput(command, commandArguments) {
  return spawnOutput(command, commandArguments);
}

function spawnOutput(command, commandArguments) {
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
