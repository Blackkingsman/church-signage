"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("../vm/obs_live_watcher");

test("buildPayload has the exact backend shape", () => {
  const p = w.buildPayload({ streaming: true, obsConnected: true, detail: "obs 32.0, bitrate 29800 kbps", now: new Date("2026-11-15T01:02:03Z") });
  assert.deepEqual(p, { streaming: true, source: "obs", at: "2026-11-15T01:02:03.000Z", obsConnected: true, detail: "obs 32.0, bitrate 29800 kbps" });
});

test("buildPayload forces streaming false when OBS is unreachable", () => {
  const p = w.buildPayload({ streaming: true, obsConnected: false, detail: "obs: ECONNREFUSED" });
  assert.equal(p.streaming, false);
  assert.equal(p.obsConnected, false);
});

test("detail is capped at 200 chars and whitespace-collapsed", () => {
  assert.equal(w.trimDetail("x".repeat(500)).length, 200);
  assert.equal(w.trimDetail("a\n  b"), "a b");
  assert.equal(w.trimDetail(undefined), "");
});

test("stateChanged fires on streaming or connection flips only", () => {
  const a = { streaming: false, obsConnected: true };
  assert.equal(w.stateChanged(null, a), true);
  assert.equal(w.stateChanged(a, { ...a }), false);
  assert.equal(w.stateChanged(a, { streaming: true, obsConnected: true }), true);
  assert.equal(w.stateChanged(a, { streaming: false, obsConnected: false }), true);
});

test("nextBackoff doubles and caps at 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(w.nextBackoff), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("bitrateKbps from byte deltas", () => {
  assert.equal(w.bitrateKbps({ bytes: 0, at: 0 }, { bytes: 3750000, at: 1000 }), 30000);
  assert.equal(w.bitrateKbps(null, { bytes: 1, at: 1 }), null);
  assert.equal(w.bitrateKbps({ bytes: 10, at: 0 }, { bytes: 5, at: 1000 }), null);
});

test("describeConnected", () => {
  assert.equal(w.describeConnected({ version: "32.0.1", streaming: true, kbps: 29800 }), "obs 32.0.1, bitrate 29800 kbps");
  assert.equal(w.describeConnected({ version: "32.0.1", streaming: false, kbps: null }), "obs 32.0.1, not streaming");
});

test("computeAuth matches the obs-websocket v5 algorithm", () => {
  const crypto = require("crypto");
  const sha = s => crypto.createHash("sha256").update(s).digest("base64");
  assert.equal(w.computeAuth("pw", "salt", "chal"), sha(sha("pwsalt") + "chal"));
});

test("parseEnvFile handles quotes, comments, export", () => {
  const env = w.parseEnvFile('# c\nOBS_WS_PORT=4455   # port\nOBS_WS_PASSWORD="a b#c"\nexport MAC_MINI_IP=1.2.3.4\nbad line\n');
  assert.deepEqual(env, { OBS_WS_PORT: "4455", OBS_WS_PASSWORD: "a b#c", MAC_MINI_IP: "1.2.3.4" });
});

test("buildConfig defaults and host fallback", () => {
  const c = w.buildConfig({ MAC_MINI_IP: "10.0.0.5", INTERNAL_API_TOKEN: "t" }, {});
  assert.equal(c.obsUrl, "ws://10.0.0.5:4455");
  assert.equal(c.backendUrl, "https://api.awesomechurchkorea.com");
  assert.equal(c.token, "t");
  assert.equal(w.buildConfig({ OBS_WS_HOST: "h", OBS_WS_PORT: "1", BACKEND_URL: "http://x/" }, {}).backendUrl, "http://x");
  assert.equal(w.buildConfig({}, {}).obsUrl, "");
});
