// 信创服务器配置报价工具 - Node 版静态服务（零依赖，仅用 Node 标准库）
// 用法: node server.js
// 仅在系统未安装 Python 时作为 server.py 的兜底方案。
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE_DIR = __dirname;
const WEB_DIR = path.join(BASE_DIR, "web");
// 默认仅监听本机，与 server.py 保持一致；如需对外暴露请显式设置 HOST=0.0.0.0
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = parseInt(process.env.PORT || "8000", 10);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function findFreePort(startPort, tries = 10) {
  // Node 无法预先绑定探测，这里直接用 http 服务尝试监听，失败时顺延。
  return new Promise((resolve) => {
    let offset = 0;
    function tryListen() {
      const port = startPort + offset;
      const srv = http.createServer(handler);
      srv.once("error", (err) => {
        srv.close();
        if (err.code === "EADDRINUSE" && offset < tries) {
          offset += 1;
          tryListen();
        } else {
          resolve(null);
        }
      });
      srv.listen(port, HOST, () => {
        resolve({ srv, port });
      });
    }
    tryListen();
  });
}

function serveFile(res, fp) {
  const ext = path.extname(fp).toLowerCase();
  const ct = CONTENT_TYPES[ext] || "application/octet-stream";
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": ct,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

function handler(req, res) {
  let pathname = decodeURIComponent(req.url.split("?")[0]);
  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(res, path.join(WEB_DIR, "index.html"));
  }
  // 目录穿越防护
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fp = path.join(WEB_DIR, safe);
  if (!fp.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (path.extname(fp)) {
    return serveFile(res, fp);
  }
  // 无扩展名的路径回退到首页（SPA）
  return serveFile(res, path.join(WEB_DIR, "index.html"));
}

(async function main() {
  if (!fs.existsSync(WEB_DIR)) {
    console.error("未找到 web 目录:", WEB_DIR);
    process.exit(1);
  }
  const result = await findFreePort(DEFAULT_PORT);
  if (!result) {
    console.error(`错误：端口 ${DEFAULT_PORT}~${DEFAULT_PORT + 10} 均无法绑定，请关闭占用程序后重试。`);
    process.exit(1);
  }
  const { srv, port } = result;
  if (port !== DEFAULT_PORT) {
    console.log(`注意：默认端口 ${DEFAULT_PORT} 不可用，已自动改用端口 ${port}。`);
  }
  console.log(`服务器已启动（Node 静态）: http://localhost:${port}`);
  console.log(`静态目录: ${WEB_DIR}`);
  console.log("按 Ctrl+C 停止。");
})();
