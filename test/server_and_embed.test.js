const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function loadEmbed() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const a = html.indexOf("function youtubeEmbedUrl");
  const b = html.indexOf("\n    function ", a + 10);
  const window = { location: { origin: "http://x", search: "", href: "http://x/" } };
  return new Function("window", `${html.slice(a, b)}; return youtubeEmbedUrl;`)(window);
}

test("youtubeEmbedUrl only accepts https YouTube links", () => {
  const f = loadEmbed();
  assert.match(f("https://youtu.be/abc"), /^https:\/\/www\.youtube\.com\/embed\/abc\?/);
  assert.match(f("https://www.youtube.com/watch?v=xyz"), /embed\/xyz\?/);
  assert.match(f("https://www.youtube-nocookie.com/embed/ab"), /embed\/ab\?/);
  for (const bad of ["http://youtu.be/a", "https://evil.com/youtube.com", "https://youtube.com.evil.com/watch?v=1",
    "javascript:alert(1)", "not a url", "https://x.com/a.m3u8", ""]) {
    assert.strictEqual(f(bad), "", bad);
  }
});

test("malformed percent escape returns 400 and the server survives", async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")],
    { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 700));
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: p }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); })
        .on("error", reject);
    });
    assert.strictEqual(await get("/%E0%A4%A"), 400);
    assert.strictEqual(await get("/version.json"), 200);
  } finally {
    child.kill();
  }
});
