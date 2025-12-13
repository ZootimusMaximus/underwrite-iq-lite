/**
 * Simple test server for running e2e tests without Vercel CLI
 * This directly imports and runs the serverless functions
 */

const http = require("http");
const path = require("path");
const fs = require("fs");

// Import API handlers
const switchboardHandler = require("./api/lite/switchboard");
const parseReportHandler = require("./api/lite/parse-report");

const PORT = process.env.PORT || 3000;

// Simple request/response wrapper to mimic Vercel's interface
function createMockRes() {
  const headers = {};
  let statusCode = 200;
  let body = null;

  return {
    statusCode,
    setHeader(key, value) {
      headers[key] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      body = JSON.stringify(data);
      this.setHeader("Content-Type", "application/json");
      return { statusCode, headers, body };
    },
    send(data) {
      body = data;
      return { statusCode, headers, body };
    },
    end(data) {
      if (data) body = data;
      return { statusCode, headers, body };
    }
  };
}

const server = http.createServer(async (req, res) => {
  // Set CORS headers for testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Route to switchboard
  if (url.pathname === "/api/lite/switchboard") {
    try {
      const mockRes = createMockRes();
      const result = await switchboardHandler(req, mockRes);

      if (result && result.statusCode) {
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } else {
        // If handler didn't return, it modified mockRes directly
        res.writeHead(mockRes.statusCode, mockRes.headers);
        res.end(mockRes.body);
      }
    } catch (err) {
      console.error("Switchboard error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Route to parse-report
  if (url.pathname === "/api/lite/parse-report") {
    try {
      const mockRes = createMockRes();
      const result = await parseReportHandler(req, mockRes);

      if (result && result.statusCode) {
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } else {
        res.writeHead(mockRes.statusCode, mockRes.headers);
        res.end(mockRes.body);
      }
    } catch (err) {
      console.error("Parse report error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Serve static files from public/
  if (req.method === "GET") {
    const filePath = path.join(__dirname, "public", url.pathname.slice(1) || "index.html");

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
      }[ext] || "text/plain";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n✅ Test server running at http://localhost:${PORT}`);
  console.log(`   - Switchboard: http://localhost:${PORT}/api/lite/switchboard`);
  console.log(`   - Parse Report: http://localhost:${PORT}/api/lite/parse-report`);
  console.log(`   - Tester UI: http://localhost:${PORT}/tester.html\n`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down test server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});
