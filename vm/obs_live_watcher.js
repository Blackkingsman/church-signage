#!/usr/bin/env node
"use strict";

// OBS live watcher: connects to OBS (obs-websocket v5) and reports the
// streaming state to the church backend every 15 s, and immediately on change.
// Runs on the media VM as root (it reads /etc/awesomechurch-media.env).
// Config: OBS_WS_HOST (default MAC_MINI_IP), OBS_WS_PORT, OBS_WS_PASSWORD,
// BACKEND_URL, INTERNAL_API_TOKEN, OBS_WATCHER_STATE_FILE (optional).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPORT_INTERVAL_MS = 15000;
const HTTP_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 5000;
const IDENTIFY_TIMEOUT_MS = 10000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const DETAIL_MAX = 200;
const CONFIG_FILE = "/etc/awesomechurch-media.env";
const DEFAULT_BACKEND = "https://api.awesomechurchkorea.com";
const DEFAULT_STATE_FILE = "/run/obs-live-watcher/last.json";

// ---------- pure helpers (unit tested) ----------

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

function buildConfig(fileEnv, procEnv = {}) {
  const get = key => (procEnv[key] !== undefined && procEnv[key] !== "" ? procEnv[key] : fileEnv[key]);
  const host = get("OBS_WS_HOST") || get("MAC_MINI_IP") || "";
  const port = Number(get("OBS_WS_PORT")) || 4455;
  return {
    obsUrl: host ? `ws://${host}:${port}` : "",
    obsPassword: get("OBS_WS_PASSWORD") || "",
    backendUrl: (get("BACKEND_URL") || DEFAULT_BACKEND).replace(/\/+$/, ""),
    token: get("INTERNAL_API_TOKEN") || "",
    stateFile: get("OBS_WATCHER_STATE_FILE") || DEFAULT_STATE_FILE
  };
}

function trimDetail(text) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 3)}...` : s;
}

function buildPayload({ streaming, obsConnected, detail, now = new Date() }) {
  const connected = Boolean(obsConnected);
  return {
    streaming: connected && Boolean(streaming),
    source: "obs",
    at: now.toISOString(),
    obsConnected: connected,
    detail: trimDetail(detail)
  };
}

function bitrateKbps(prev, cur) {
  if (!prev || !cur) return null;
  const bytes = cur.bytes - prev.bytes;
  const seconds = (cur.at - prev.at) / 1000;
  if (!(bytes >= 0) || !(seconds > 0)) return null;
  return Math.round((bytes * 8) / 1000 / seconds);
}

function describeConnected({ version, streaming, kbps }) {
  const parts = [`obs ${version || "?"}`];
  if (streaming && kbps != null) parts.push(`bitrate ${kbps} kbps`);
  else if (!streaming) parts.push("not streaming");
  return parts.join(", ");
}

// Report right away when the streaming flag or the connection flips.
function stateChanged(prev, next) {
  if (!prev) return true;
  return prev.streaming !== next.streaming || prev.obsConnected !== next.obsConnected;
}

function nextBackoff(attempt) {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 10));
}

// obs-websocket v5: base64(sha256(base64(sha256(password + salt)) + challenge))
function computeAuth(password, salt, challenge) {
  const secret = crypto.createHash("sha256").update(password + salt).digest("base64");
  return crypto.createHash("sha256").update(secret + challenge).digest("base64");
}

// ---------- runtime ----------

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

class Watcher {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.connected = false;
    this.streaming = false;
    this.version = "";
    this.lastError = "";
    this.attempt = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.prevBytes = null;
    this.kbps = null;
    this.lastSent = null;
    this.reconnectTimer = null;
  }

  start() {
    this.connect();
    setInterval(() => this.tick().catch(e => log(`tick failed: ${e.message}`)), REPORT_INTERVAL_MS);
    this.tick().catch(e => log(`tick failed: ${e.message}`));
  }

  connect() {
    this.reconnectTimer = null;
    if (!this.config.obsUrl) {
      this.lastError = "OBS_WS_HOST/MAC_MINI_IP not set";
      log(this.lastError);
      return this.scheduleReconnect();
    }
    let WebSocket;
    try {
      WebSocket = require("ws");
    } catch (error) {
      this.lastError = "ws module missing (run vm/install.sh)";
      log(this.lastError);
      return this.scheduleReconnect();
    }
    let ws;
    try {
      ws = new WebSocket(this.config.obsUrl, "obswebsocket.json", { handshakeTimeout: 10000 });
    } catch (error) {
      this.lastError = `connect failed: ${error.message}`;
      log(this.lastError);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    const identifyTimer = setTimeout(() => {
      this.lastError = "OBS did not answer the identify handshake";
      try { ws.terminate(); } catch (_) {}
    }, IDENTIFY_TIMEOUT_MS);

    ws.on("message", data => {
      try {
        this.onMessage(ws, JSON.parse(data.toString()), identifyTimer);
      } catch (error) {
        log(`bad OBS message: ${error.message}`);
      }
    });
    ws.on("error", error => {
      this.lastError = `obs: ${error.message || error.code || "socket error"}`;
    });
    ws.on("close", () => {
      clearTimeout(identifyTimer);
      if (this.ws !== ws) return;
      const was = this.connected;
      this.ws = null;
      this.connected = false;
      this.streaming = false;
      this.prevBytes = null;
      this.kbps = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("OBS connection closed")); }
      this.pending.clear();
      if (was) log(`OBS connection lost: ${this.lastError || "closed"}`);
      this.scheduleReconnect();
      if (was) this.report().catch(() => {});
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = nextBackoff(this.attempt++);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  onMessage(ws, msg, identifyTimer) {
    const { op, d } = msg;
    if (op === 0) {
      const identify = { rpcVersion: 1 };
      if (d.authentication) {
        if (!this.config.obsPassword) {
          this.lastError = "OBS requires a password but OBS_WS_PASSWORD is empty";
          return ws.terminate();
        }
        identify.authentication = computeAuth(this.config.obsPassword, d.authentication.salt, d.authentication.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (op === 2) {
      clearTimeout(identifyTimer);
      this.connected = true;
      this.attempt = 0;
      this.lastError = "";
      log("connected to OBS");
      this.refresh().catch(e => log(`initial refresh failed: ${e.message}`));
    } else if (op === 5) {
      if (d && d.eventType === "StreamStateChanged") {
        this.refresh().catch(e => log(`refresh after event failed: ${e.message}`));
      }
    } else if (op === 7) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error(`${d.requestType} failed: ${d.requestStatus && d.requestStatus.comment}`));
    }
  }

  request(requestType) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new Error("not connected to OBS"));
      const requestId = `w${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
        try { this.ws && this.ws.terminate(); } catch (_) {}
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId } }));
    });
  }

  // Query OBS; report at once if the streaming flag changed.
  async refresh() {
    const before = { streaming: this.streaming, obsConnected: this.connected };
    if (!this.version) {
      try { this.version = (await this.request("GetVersion")).obsVersion || ""; } catch (_) {}
    }
    const status = await this.request("GetStreamStatus");
    const sample = { bytes: Number(status.outputBytes) || 0, at: Date.now() };
    this.streaming = Boolean(status.outputActive);
    this.kbps = this.streaming ? bitrateKbps(this.prevBytes, sample) : null;
    this.prevBytes = this.streaming ? sample : null;
    if (stateChanged(before, { streaming: this.streaming, obsConnected: this.connected })) {
      await this.report();
    }
  }

  async tick() {
    if (this.connected) {
      try {
        await this.refresh();
      } catch (error) {
        this.lastError = error.message;
        log(`OBS query failed: ${error.message}`);
      }
    }
    await this.report();
  }

  detail() {
    if (this.connected) return describeConnected({ version: this.version, streaming: this.streaming, kbps: this.kbps });
    return this.lastError || "OBS not connected";
  }

  async report() {
    const payload = buildPayload({ streaming: this.streaming, obsConnected: this.connected, detail: this.detail() });
    const result = { report: payload, ok: false, httpStatus: null, error: "" };
    if (!this.config.token) {
      result.error = "INTERNAL_API_TOKEN not set; not reporting";
      log(result.error);
    } else {
      try {
        const res = await fetch(`${this.config.backendUrl}/api/internal/stream-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Token": this.config.token },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
        });
        result.httpStatus = res.status;
        result.ok = res.ok;
        if (!res.ok) {
          result.error = `backend returned HTTP ${res.status}`;
          log(result.error);
        }
      } catch (error) {
        result.error = `backend report failed: ${error.message}`;
        log(result.error);
      }
    }
    result.sentAt = new Date().toISOString();
    this.lastSent = result;
    this.writeState(result);
    return result;
  }

  writeState(result) {
    try {
      fs.mkdirSync(path.dirname(this.config.stateFile), { recursive: true, mode: 0o755 });
      const tmp = `${this.config.stateFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
      fs.renameSync(tmp, this.config.stateFile);
    } catch (error) {
      log(`could not write ${this.config.stateFile}: ${error.message}`);
    }
  }
}

function main() {
  process.on("uncaughtException", error => log(`uncaught: ${error && error.stack || error}`));
  process.on("unhandledRejection", error => log(`unhandled rejection: ${error && error.stack || error}`));
  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(fs.readFileSync(process.env.MEDIA_ENV_FILE || CONFIG_FILE, "utf8"));
  } catch (error) {
    log(`cannot read env file: ${error.message}`);
  }
  const config = buildConfig(fileEnv, process.env);
  log(`obs-live-watcher starting (obs ${config.obsUrl || "unset"}, backend ${config.backendUrl}, token ${config.token ? "set" : "MISSING"})`);
  new Watcher(config).start();
}

if (require.main === module) main();

module.exports = { parseEnvFile, buildConfig, trimDetail, buildPayload, bitrateKbps, describeConnected, stateChanged, nextBackoff, computeAuth };
