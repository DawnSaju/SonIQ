#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "darwin") {
  fail("A SonIQ macOS DMG can only be finalized on macOS.");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const tauriConfig = JSON.parse(readFileSync(join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const targetTriple = targetTripleFor(process.arch);
const productName = tauriConfig.productName;
const version = tauriConfig.version;
const appPath = join(repositoryRoot, "src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
const runtimePath = join(appPath, "Contents", "Resources", "release-runtime", targetTriple);
const resourcesPath = join(appPath, "Contents", "Resources");
const dmgPath = join(
  repositoryRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "dmg",
  `${productName}_${version}_${process.arch === "arm64" ? "aarch64" : "x64"}.dmg`,
);

if (!existsSync(appPath)) {
  fail(`The release app is missing. Build it first: ${appPath}`);
}

for (const binary of ["ffmpeg", "ffprobe", "soniq-recognition"]) {
  const binaryPath = join(runtimePath, binary);
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    fail(`The release app is missing the bundled ${binary} runtime: ${binaryPath}`);
  }
}

for (const legalDocument of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  const legalDocumentPath = join(resourcesPath, legalDocument);
  if (!existsSync(legalDocumentPath) || !statSync(legalDocumentPath).isFile()) {
    fail(`The release app is missing its bundled ${legalDocument}: ${legalDocumentPath}`);
  }
}

console.log("Ad-hoc signing the complete SonIQ.app bundle…");
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

console.log(`Creating ${dmgPath}…`);
run("/usr/bin/hdiutil", [
  "create",
  "-volname",
  productName,
  "-srcfolder",
  appPath,
  "-ov",
  "-format",
  "UDZO",
  dmgPath,
]);
run("/usr/bin/hdiutil", ["verify", dmgPath]);

const checksum = commandOutput("/usr/bin/shasum", ["-a", "256", dmgPath]).trim();
console.log("Release DMG verified:");
console.log(`  ${dmgPath}`);
console.log(`  ${checksum}`);
console.log("This DMG is ad-hoc signed, not Developer ID signed or notarized.");

function targetTripleFor(nodeArchitecture) {
  if (nodeArchitecture === "arm64") return "aarch64-apple-darwin";
  if (nodeArchitecture === "x64") return "x86_64-apple-darwin";
  fail(`Unsupported local macOS architecture: ${nodeArchitecture}. Expected arm64 or x64.`);
}

function commandOutput(command, commandArguments) {
  const result = spawnSync(command, commandArguments, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    fail(`Command failed: ${command} ${commandArguments.join(" ")}\n${output}`);
  }
  return output;
}

function run(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    fail(`Command failed: ${command} ${commandArguments.join(" ")}`);
  }
}

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}
