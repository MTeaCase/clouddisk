/**
 * 端到端联调：用 esbuild 打包真实 Worker 源码，注入内存版 R2，直接调用 fetch handler。
 * 覆盖：登录/鉴权、目录、上传（小文件 + 分片）、下载（Range）、配额拦截、
 *      重命名、分享链接、回收站（删除/恢复/清空）、路径穿越与 HTML 预览安全。
 *
 * 运行：node tests/e2e.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { R2BucketMock } from "./r2-mock.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bundlePath = path.join(root, "tests", ".worker-bundle.mjs");

await build({
  entryPoints: [path.join(root, "worker", "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: bundlePath,
  logLevel: "error",
});

const { default: worker } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

const MiB = 1024 * 1024;
const PASSWORD = "test-password-9876";
const SECRET = "test-secret-0123456789abcdef";

function makeEnv({ soft = 200 * MiB, hard = 256 * MiB } = {}) {
  return {
    BUCKET: new R2BucketMock(),
    ACCESS_PASSWORD: PASSWORD,
    SESSION_SECRET: SECRET,
    QUOTA_SOFT_BYTES: String(soft),
    QUOTA_HARD_BYTES: String(hard),
    TRASH_RETENTION_DAYS: "30",
    ALLOWED_ORIGINS: "*",
  };
}

function makeClient(env) {
  const base = "https://api.example.com";
  return async function api(pathname, { method = "GET", body, token, headers = {}, raw = false } = {}) {
    const url = pathname.startsWith("http") ? pathname : base + pathname;
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        init.body = body;
        init.headers["Content-Length"] = String(body.byteLength);
      } else {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] = "application/json";
      }
    }
    const res = await worker.fetch(new Request(url, init), env);
    if (raw) return res;
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: res.headers };
  };
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) b.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, n - i))), i);
  return b;
}

console.log("\n[1] 鉴权");
const env = makeEnv();
const api = makeClient(env);
let token;

await step("健康检查", async () => {
  const r = await api("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.service, "clouddisk-api");
});

await step("未登录访问被拒绝 401", async () => {
  const r = await api("/api/list");
  assert.equal(r.status, 401);
});

await step("错误密码 401", async () => {
  const r = await api("/api/auth/login", { method: "POST", body: { password: "wrong-password" } });
  assert.equal(r.status, 401);
});

await step("正确密码登录并拿到令牌", async () => {
  const r = await api("/api/auth/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  token = r.body.token;
});

await step("伪造令牌被拒绝", async () => {
  const r = await api("/api/list", { token: `${token.slice(0, -4)}aaaa` });
  assert.equal(r.status, 401);
});

console.log("\n[2] 目录与上传");
await step("新建文件夹", async () => {
  const r = await api("/api/folder", { method: "POST", body: { prefix: "", name: "文档" }, token });
  assert.equal(r.status, 200);
});

await step("列表能看到文件夹", async () => {
  const r = await api("/api/list?prefix=", { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.folders.map((f) => f.name), ["文档"]);
});

await step("中文名小文件上传（1 MiB）", async () => {
  const payload = randomBytes(1 * MiB);
  const r = await api("/api/upload/put?key=%E6%96%87%E6%A1%A3%2F%E6%B5%8B%E8%AF%95.bin&ct=application%2Foctet-stream", {
    method: "PUT",
    body: payload,
    token,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.file.size, 1 * MiB);
});

await step("列举目录内文件并核对大小", async () => {
  const r = await api("/api/list?prefix=%E6%96%87%E6%A1%A3%2F", { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.files.length, 1);
  assert.equal(r.body.files[0].name, "测试.bin");
  assert.equal(r.body.files[0].size, 1 * MiB);
});

await step("同名文件重复上传 409", async () => {
  const r = await api("/api/upload/put?key=%E6%96%87%E6%A1%A3%2F%E6%B5%8B%E8%AF%95.bin", {
    method: "PUT",
    body: randomBytes(1024),
    token,
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
});

await step("伪造的 Content-Length 被识破", async () => {
  const url = "https://api.example.com/api/upload/put?key=a.bin";
  const body = new Uint8Array(100);
  const res = await worker.fetch(
    new Request(url, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Length": "50" }, body }),
    env,
  );
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.code, "size_mismatch");
});

await step("分片上传 30 MiB（2 个分片）", async () => {
  const size = 30 * MiB;
  const init = await api("/api/upload/init", {
    method: "POST",
    body: { key: "文档/大文件.bin", size, contentType: "application/octet-stream" },
    token,
  });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  assert.equal(init.body.mode, "multipart");
  const partSize = init.body.partSize;
  const payload = randomBytes(size);
  const parts = [];
  for (let i = 0; i < init.body.parts; i++) {
    const chunk = payload.subarray(i * partSize, Math.min(size, (i + 1) * partSize));
    const p = await api(
      `/api/upload/part?key=${encodeURIComponent("文档/大文件.bin")}&uploadId=${init.body.uploadId}&n=${i + 1}`,
      { method: "PUT", body: chunk, token },
    );
    assert.equal(p.status, 200, JSON.stringify(p.body));
    parts.push({ partNumber: p.body.partNumber, etag: p.body.etag });
  }
  const done = await api("/api/upload/complete", {
    method: "POST",
    body: { key: "文档/大文件.bin", uploadId: init.body.uploadId, size, parts },
    token,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.file.size, size);
});

console.log("\n[3] 下载与 Range");
await step("整文件下载内容长度正确", async () => {
  const res = await api(`/api/file?key=${encodeURIComponent("文档/测试.bin")}`, { token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(1 * MiB));
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.equal(buf.byteLength, 1 * MiB);
});

await step("Range 请求返回 206 且长度正确", async () => {
  const res = await api(`/api/file?key=${encodeURIComponent("文档/测试.bin")}`, {
    token,
    raw: true,
    headers: { Range: "bytes=100-199" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 100-199/${1 * MiB}`);
  assert.equal(res.headers.get("content-length"), "100");
});

await step("非法 Range 返回 416", async () => {
  const res = await api(`/api/file?key=${encodeURIComponent("文档/测试.bin")}`, {
    token,
    raw: true,
    headers: { Range: "bytes=99999999-" },
  });
  assert.equal(res.status, 416);
});

console.log("\n[4] 重命名 / 分享");
await step("重命名文件", async () => {
  const r = await api("/api/rename", { method: "POST", body: { key: "文档/测试.bin", name: "改名后.bin" }, token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = await api("/api/list?prefix=%E6%96%87%E6%A1%A3%2F", { token });
  assert.ok(list.body.files.some((f) => f.name === "改名后.bin"));
});

let shareUrl;
await step("生成分享链接（无需登录即可访问）", async () => {
  const r = await api("/api/share", { method: "POST", body: { key: "文档/改名后.bin", hours: 2 }, token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  shareUrl = r.body.url;
  const res = await worker.fetch(new Request(shareUrl), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(1 * MiB));
});

await step("篡改分享令牌被拒绝", async () => {
  const bad = shareUrl.replace(/t=([^&]+)/, "t=$1x");
  const res = await worker.fetch(new Request(bad), env);
  assert.equal(res.status, 403);
});

await step("路径穿越被拒绝", async () => {
  const r = await api("/api/upload/put?key=..%2F..%2Fetc%2Fpasswd", { method: "PUT", body: new Uint8Array(10), token });
  assert.equal(r.status, 400);
});

await step("HTML 文件以内联纯文本返回（防 XSS）", async () => {
  await api("/api/upload/put?key=evil.html&ct=text%2Fhtml", { method: "PUT", body: new TextEncoder().encode("<script>alert(1)</script>"), token });
  const res = await worker.fetch(
    new Request(`https://api.example.com/api/file?key=evil.html`, { headers: { Authorization: `Bearer ${token}` } }),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
});

console.log("\n[5] 回收站");
await step("删除进入回收站，用量仍占用", async () => {
  const before = await api("/api/usage", { token });
  const r = await api("/api/delete", { method: "POST", body: { keys: ["文档/改名后.bin"] }, token });
  assert.equal(r.status, 200);
  assert.equal(r.body.trashed, 1);
  const trash = await api("/api/trash", { token });
  assert.equal(trash.body.entries.length, 1);
  assert.equal(trash.body.entries[0].origKey, "文档/改名后.bin");
  const after = await api("/api/usage?refresh=1", { token });
  assert.equal(after.body.usage.total, before.body.usage.total, "软删除不应改变总量");
  assert.ok(after.body.usage.trash >= 1 * MiB);
});

await step("从回收站恢复", async () => {
  const trash = await api("/api/trash", { token });
  const r = await api("/api/trash/restore", { method: "POST", body: { ids: [trash.body.entries[0].id] }, token });
  assert.equal(r.status, 200);
  const list = await api("/api/list?prefix=%E6%96%87%E6%A1%A3%2F", { token });
  assert.ok(list.body.files.some((f) => f.name === "改名后.bin"), "恢复后文件应回到原目录");
});

await step("删除后清空回收站，用量下降", async () => {
  const before = await api("/api/usage?refresh=1", { token });
  const del = await api("/api/delete", { method: "POST", body: { keys: ["文档/大文件.bin"] }, token });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const afterDel = await api("/api/usage?refresh=1", { token });
  assert.equal(afterDel.body.usage.total, before.body.usage.total, "软删除不应立即释放空间");
  assert.ok(afterDel.body.usage.trash >= 30 * MiB, "回收站应统计到 30 MiB");
  const purged = await api("/api/trash/purge", { method: "POST", body: { all: true }, token });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  const after = await api("/api/usage?refresh=1", { token });
  assert.equal(after.body.usage.trash, 0, "清空后回收站应为 0");
  assert.ok(after.body.usage.total < before.body.usage.total, "清空后总量应下降");
});

console.log("\n[6] 配额（9.5 GiB 停止上传的等价逻辑）");
const smallEnv = makeEnv({ soft: 2 * MiB, hard: 3 * MiB });
const smallApi = makeClient(smallEnv);
const loginSmall = await smallApi("/api/auth/login", { method: "POST", body: { password: PASSWORD } });
const smallToken = loginSmall.body.token;

await step("1.5 MiB 上传成功", async () => {
  const r = await smallApi("/api/upload/put?key=ok.bin", { method: "PUT", body: randomBytes(1.5 * MiB), token: smallToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

await step("超过软上限立即 507 且不写入对象", async () => {
  const r = await smallApi("/api/upload/put?key=blocked.bin", { method: "PUT", body: randomBytes(1 * MiB), token: smallToken });
  assert.equal(r.status, 507, JSON.stringify(r.body));
  assert.equal(r.body.code, "quota_exceeded");
  assert.equal(smallEnv.BUCKET.objects.has("blocked.bin"), false);
});

await step("分片上传在 init 阶段就被拦截", async () => {
  const r = await smallApi("/api/upload/init", {
    method: "POST",
    body: { key: "big.bin", size: 30 * MiB, contentType: "application/octet-stream" },
    token: smallToken,
  });
  assert.equal(r.status, 507);
});

await step("usage 报告剩余空间，且再传 0.6 MiB 仍被拒", async () => {
  const r = await smallApi("/api/usage?refresh=1", { token: smallToken });
  assert.ok(r.body.usage.remaining >= 0 && r.body.usage.remaining < 1 * MiB, `remaining=${r.body.usage.remaining}`);
  const again = await smallApi("/api/upload/put?key=blocked2.bin", {
    method: "PUT",
    body: randomBytes(0.6 * MiB),
    token: smallToken,
  });
  assert.equal(again.status, 507, JSON.stringify(again.body));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
fs.rmSync(bundlePath, { force: true });