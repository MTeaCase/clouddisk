/**
 * 本地预览服务器：用 Node 直接跑真实 Worker 代码 + 内存版 R2，并托管 web/ 静态文件。
 *
 * 用途：在这台机器上 `wrangler dev` 的 workerd 存在 Windows 目录权限问题
 * （kj/filesystem-disk-win32 CreateDirectory miniflare-email-store 失败）时，
 * 仍能完整地调试前端与 API。数据只在内存中，进程退出即清空。
 *
 * 用法：
 *   node scripts/dev-server.mjs            # 空盘启动
 *   node scripts/dev-server.mjs --seed     # 带演示文件
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { R2BucketMock } from "../tests/r2-mock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const PORT = Number(process.env.PORT || 8080);
const PASSWORD = "dev-password-1234";
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const bundle = path.join(root, "tests", ".dev-bundle.mjs");
await build({
  entryPoints: [path.join(root, "worker", "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: bundle,
  logLevel: "error",
});
const { default: worker } = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

const env = {
  BUCKET: new R2BucketMock(),
  ACCESS_PASSWORD: PASSWORD,
  SESSION_SECRET: "local-dev-secret-0123456789abcdef",
  QUOTA_SOFT_BYTES: String(9.5 * GiB),
  QUOTA_HARD_BYTES: String(10 * GiB),
  TRASH_RETENTION_DAYS: "30",
  ALLOWED_ORIGINS: "*",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    // 本地内存 R2 没有 S3 接口，直连通道直接返回不可用，让前端走代理回退路径
    if (url.pathname.startsWith("/api/pm/")) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, code: "no_s3_in_dev", message: "本地预览未启用直连通道" }));
    }
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      }
      const method = req.method.toUpperCase();
      const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(req);
      if (body) headers.set("content-length", String(body.byteLength));
      const request = new Request(url.href, { method, headers, body });
      const response = await worker.fetch(request, env);
      const outHeaders = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(response.status, outHeaders);
      if (!response.body) return res.end();
      Readable.fromWeb(response.body).pipe(res);
      return;
    } catch (err) {
      console.error("worker error", err);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, message: String(err?.message || err) }));
    }
  }

  let filePath = path.join(webDir, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || url.pathname === "") filePath = path.join(webDir, "index.html");
  if (!filePath.startsWith(webDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(webDir, "index.html");
  }
  let content = fs.readFileSync(filePath);

  // 仅本地预览用：?auto=1 时注入令牌，便于截图 / 直接进入界面
  if (url.searchParams.get("auto") === "1" && filePath.endsWith("index.html")) {
    const login = await worker.fetch(
      new Request(`http://127.0.0.1:${PORT}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
      env,
    );
    const { token } = await login.json();
    const prefs = [];
    if (url.searchParams.get("theme")) prefs.push(`localStorage.setItem("clouddisk.theme", ${JSON.stringify(url.searchParams.get("theme"))});`);
    if (url.searchParams.get("view")) prefs.push(`localStorage.setItem("clouddisk.view", ${JSON.stringify(url.searchParams.get("view"))});`);
    content = Buffer.from(
      content
        .toString("utf8")
        .replace(
          '<script type="module" src="./app.js"></script>',
          `<script>localStorage.setItem("clouddisk.token", ${JSON.stringify(token)});${prefs.join("")}</script>
     <script type="module" src="./app.js"></script>`,
        ),
    );
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(content);
});

async function seed() {
  const now = Date.now();
  const files = [
    { key: "设计稿/首页-视觉方案-v3.png", size: Math.round(2.4 * MiB), type: "image/png", days: 0.1 },
    { key: "设计稿/组件库规范.png", size: Math.round(860 * 1024), type: "image/png", days: 2 },
    { key: "文档/项目计划-2026.md", size: 18_432, type: "text/markdown; charset=utf-8", days: 1, text: true },
    { key: "文档/周会纪要.txt", size: 6_238, type: "text/plain; charset=utf-8", days: 4, text: true },
    { key: "照片/海边日落.jpg", size: Math.round(4.1 * MiB), type: "image/jpeg", days: 8 },
    { key: "照片/城市夜景.jpg", size: Math.round(3.2 * MiB), type: "image/jpeg", days: 23 },
    { key: "视频/产品演示.mp4", size: Math.round(48 * MiB), type: "video/mp4", days: 12 },
    { key: "备份/2026-10-照片归档.zip", size: Math.round(62 * MiB), type: "application/zip", days: 31 },
  ];
  for (const f of files) {
    const bytes = f.text
      ? new TextEncoder().encode(
          f.key.includes("计划")
            ? "# 项目计划 2026\n\n## 本周目标\n- 完成云盘 1.0 的配额控制（9.5 GiB 停止上传）\n- 前端补齐拖拽上传与预览\n- 补充中国大陆访问方案说明\n\n## 风险\n1. R2 在中国大陆没有边缘节点，下载走 Worker 会多一些延迟。\n2. 自定义域名还没绑定，先用 workers.dev / pages.dev 顶着。\n"
            : "周会纪要\n\n1. 存储：R2 桶 clouddisk，10 GiB 上限，9.5 GiB 停止上传。\n2. 前端：Pages 静态托管；计算：Worker API。\n3. 下一步：绑定自有域名，评估是否上 Cloudflare 中国网络。\n",
        )
      : new Uint8Array(f.size);
    await env.BUCKET.put(f.key, bytes, { httpMetadata: { contentType: f.type } });
    const rec = env.BUCKET.objects.get(f.key);
    rec.uploaded = new Date(now - f.days * 86400_000);
  }
  for (const dir of ["设计稿/", "文档/", "照片/", "视频/", "备份/"]) {
    await env.BUCKET.put(dir, new Uint8Array(0), { httpMetadata: { contentType: "application/x-directory" } });
  }
  console.log(`已写入 ${files.length} 个演示文件`);
}

if (process.argv.includes("--seed")) await seed();

server.listen(PORT, () => {
  console.log(`本地预览: http://127.0.0.1:${PORT}/  （密码 ${PASSWORD}，?auto=1 直接进入）`);
});