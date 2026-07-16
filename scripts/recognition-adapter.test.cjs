const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_BYTES,
  MAX_SECONDS,
  recognizePcm,
} = require("./recognition-adapter.cjs");

test("bounds enhanced PCM locally before it reaches the recognition package", async () => {
  let receivedSamples;
  const fakeRecognizer = {
    async fullRecognizeSong(samples) {
      receivedSamples = samples;
      return { track: { title: "A local test track", subtitle: "SonIQ" } };
    },
  };

  const result = await recognizePcm(Buffer.alloc(MAX_BYTES + 17), fakeRecognizer);

  assert.equal(receivedSamples.length, MAX_BYTES / 2);
  assert.deepEqual(result, {
    title: "A local test track",
    artist: "SonIQ",
    artworkUrl: null,
  });
});

test("enhanced recognition sends a locally generated signature rather than PCM", { concurrency: false }, async () => {
  const originalFetch = global.fetch;
  let capturedRequest;
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return { json: async () => ({ matches: [] }) };
  };

  const localPcm = Buffer.alloc(MAX_BYTES);
  try {
    const result = await recognizePcm(localPcm);
    assert.equal(result, null);
  } finally {
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
  }

  assert.match(capturedRequest.url, /^https:\/\/amp\.shazam\.com\/discovery\/v5\//);
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(capturedRequest.options.headers["Content-Type"], "application/json");

  const payload = JSON.parse(capturedRequest.options.body);
  assert.deepEqual(Object.keys(payload).sort(), ["context", "geolocation", "signature", "timestamp", "timezone"]);
  assert.deepEqual(Object.keys(payload.signature).sort(), ["samplems", "uri"]);
  assert.equal(payload.signature.samplems, MAX_SECONDS * 1_000);
  assert.match(payload.signature.uri, /^data:audio\/vnd\.shazam\.sig;base64,/);

  const signatureBytes = Buffer.from(payload.signature.uri.split(",", 2)[1], "base64");
  assert.ok(signatureBytes.length < localPcm.length);
  assert.notDeepEqual(signatureBytes, localPcm);
});
