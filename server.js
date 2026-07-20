const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";
const displayHost = process.env.DISPLAY_HOST || "localhost";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8"
};

function isPublicFile(relativePath) {
  if (["index.html", "content.json", "control.json"].includes(relativePath)) {
    return true;
  }

  const normalized = relativePath.replaceAll("\\", "/");
  const extension = path.extname(normalized).toLowerCase();
  return normalized.startsWith("media/")
    && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
}

function fileVersion(fileName) {
  try {
    const stats = fs.statSync(path.join(root, fileName));
    return stats.mtimeMs;
  } catch (error) {
    return 0;
  }
}

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);

  if (requestPath === "/version.json") {
    const version = {
      index: fileVersion("index.html"),
      content: fileVersion("content.json"),
      control: fileVersion("control.json")
    };

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({
      ...version,
      signature: `${version.index}:${version.content}:${version.control}`
    }));
    return;
  }

  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(root, relativePath);
  const localPath = path.relative(root, filePath);

  if (localPath.startsWith("..") || path.isAbsolute(localPath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!isPublicFile(localPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const normalizedPath = localPath.replaceAll("\\", "/");
    const cacheControl = normalizedPath.startsWith("media/")
      ? "public, max-age=31536000, immutable"
      : "no-store";

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": cacheControl,
      "Referrer-Policy": "origin-when-cross-origin"
    });
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Photo wall running at http://${displayHost}:${port}/`);
});
