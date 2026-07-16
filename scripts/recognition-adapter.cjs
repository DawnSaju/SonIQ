const fs = require("node:fs");
const { Shazam, s16LEToSamplesArray } = require("shazam-api");

const SAMPLE_RATE_HZ = 16_000;
const BYTES_PER_SAMPLE = 2;
const MAX_SECONDS = 8;
const MIN_BYTES = SAMPLE_RATE_HZ * BYTES_PER_SAMPLE;
const MAX_BYTES = SAMPLE_RATE_HZ * BYTES_PER_SAMPLE * MAX_SECONDS;

function boundedPcm(source) {
  if (!Buffer.isBuffer(source)) {
    throw new Error("The enhanced-recognition sample is not valid PCM data.");
  }

  const evenLength = source.length - (source.length % BYTES_PER_SAMPLE);
  return source.subarray(0, Math.min(evenLength, MAX_BYTES));
}

function normalizedTrack(result) {
  const track = result?.track;
  if (!track?.title || !track?.subtitle) return null;

  const artworkUrl = track.images?.coverarthq ?? track.images?.coverart;
  return {
    title: track.title,
    artist: track.subtitle,
    artworkUrl: typeof artworkUrl === "string" && artworkUrl.startsWith("https://") ? artworkUrl : null,
  };
}

async function recognizePcm(source, recognizer = new Shazam()) {
  const bounded = boundedPcm(source);
  if (bounded.length < MIN_BYTES) {
    throw new Error("The enhanced-recognition sample is too short.");
  }

  const result = await recognizer.fullRecognizeSong(s16LEToSamplesArray(bounded));
  return normalizedTrack(result);
}

async function main(inputPath = process.argv[2]) {
  if (!inputPath) throw new Error("SonIQ did not provide an enhanced-recognition sample.");

  const source = fs.readFileSync(inputPath);
  const track = await recognizePcm(source);
  if (!track) {
    process.stdout.write("null\n");
    return;
  }

  process.stdout.write(JSON.stringify(track) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  BYTES_PER_SAMPLE,
  MAX_BYTES,
  MAX_SECONDS,
  MIN_BYTES,
  SAMPLE_RATE_HZ,
  boundedPcm,
  recognizePcm,
};
