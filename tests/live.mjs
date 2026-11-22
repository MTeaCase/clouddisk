/**
 * 线上验收：对着已部署的地址跑一遍真实上传/下载/配额/回收站流程。
 * 用法：node tests/live.mjs <baseUrl> <password>
 * 数据在结束时清理干净（不留测试文件）。
 */
import crypto from "node:crypto";

const BASE = (process.argv[2] || "https://clouddisk-uv1.pages.dev").replace(/\/+$/, "");
const PASSWORD = process.argv[3] || process.env.CLOUDDISK_PASSWORD;
if (!PASSWORD) {
  console.error("缺少密码参数");
  process.exit(1);
}

const MiB = 1024 * 1024;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
assert.equal = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg ? `${msg}：` : ""}期望 ${expected}，实际 ${actual}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = "";
async function retryFetch(url, init, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

async function call(path, { method = "GET", json, body, headers = {}, auth = true, raw = false } = {}) {
  const h = { ...headers };
  if (auth && token) h.Authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (json !== undefined) {
    h["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
    h["Content-Length"] = String(body.byteLength ?? body.length);
  }
  const res = await retryFetch(`${BASE}${path}`, init);
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: data, headers: res.headers };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const random = (n) => crypto.randomBytes(n);

const STAMP = Date.now().toString(36);
const DIR = `验收测试-${STAMP}`;
const SMALL = `${DIR}/small-${STAMP}.bin`;
const BIG = `${DIR}/big-${STAMP}.bin`;

console.log(`\n目标：${BASE}\n`);

await step("健康检查", async () => {
  const r = await call("/api/health", { auth: false });
  assert(r.status === 200 && r.body.ok, `health ${r.status}`);
});

await step("未登录访问被拒（401）", async () => {
  const r = await call("/api/list", { auth: false });
  assert(r.status === 401, `期望 401，实际 ${r.status}`);
});

await step("错误密码被拒（401）", async () => {
  const r = await call("/api/auth/login", { method: "POST", json: { password: "wrong-" + PASSWORD }, auth: false });
  assert(r.status === 401, `期望 401，实际 ${r.status}`);
});

await step("登录并读取配额配置（9.5 GiB / 10 GiB）", async () => {
  const r = await call("/api/auth/login", { method: "POST", json: { password: PASSWORD }, auth: false });
  assert(r.status === 200, `login ${r.status} ${JSON.stringify(r.body)}`);
  token = r.body.token;
  const u = r.body.usage;
  assert(u.softLimit === 10200690688, `softLimit=${u.softLimit}`);
  assert(u.hardLimit === 10737418240, `hardLimit=${u.hardLimit}`);
  console.log(`    已用 ${u.total} B，软上限 ${u.softLimit} B，硬上限 ${u.hardLimit} B`);
});

await step("新建目录", async () => {
  const r = await call("/api/folder", { method: "POST", json: { prefix: `${DIR}/`, name: "子目录" } });
  assert(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
});

const smallBytes = random(Math.round(1.2 * MiB));
let smallSpeed = 0;
await step("小文件直传（1.2 MiB，预签名直连 R2）", async () => {
  const init = await call("/api/pm/init", {
    method: "POST",
    json: { key: SMALL, size: smallBytes.length, contentType: "application/octet-stream" },
  });
  assert(init.status === 200, `${init.status} ${JSON.stringify(init.body)}`);
  assert.equal(init.body.mode, "direct-single", `模式 ${init.body.mode}`);
  const t0 = Date.now();
  const put = await retryFetch(init.body.url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: smallBytes,
  });
  assert(put.status === 200, `PUT ${put.status}`);
  smallSpeed = smallBytes.length / 1e6 / ((Date.now() - t0) / 1000);
  console.log(`    ${smallSpeed.toFixed(2)} MB/s`);
  const stat = await call(`/api/stat?key=${encodeURIComponent(SMALL)}`);
  assert.equal(stat.body.file.size, smallBytes.length, "大小不符");
});

const bigBytes = random(40 * MiB);
let bigSha = sha256(bigBytes);
let bigSpeed = 0;
await step("分片直传（40 MiB，3 片，预签名直连 R2）", async () => {
  const init = await call("/api/pm/init", {
    method: "POST",
    json: { key: BIG, size: bigBytes.length, contentType: "application/octet-stream" },
  });
  assert(init.status === 200, `${init.status} ${JSON.stringify(init.body)}`);
  assert.equal(init.body.mode, "direct-multipart", `模式 ${init.body.mode}`);

  const plan = await call("/api/pm/parts", {
    method: "POST",
    json: { key: BIG, uploadId: init.body.uploadId, count: init.body.parts },
  });
  assert.equal(plan.status, 200, `${plan.status}`);
  const t0 = Date.now();
  const parts = [];
  for (const p of plan.body.parts) {
    const start = (p.partNumber - 1) * init.body.partSize;
    const end = Math.min(bigBytes.length, start + init.body.partSize);
    const put = await retryFetch(p.url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bigBytes.subarray(start, end),
    });
    assert(put.status === 200, `分片 ${p.partNumber}: ${put.status}`);
    const etag = put.headers.get("etag");
    assert(etag, "R2 没有返回 ETag（检查桶 CORS 的 ExposeHeader）");
    parts.push({ partNumber: p.partNumber, etag });
  }
  const done = await call("/api/pm/complete", {
    method: "POST",
    json: { key: BIG, uploadId: init.body.uploadId, size: bigBytes.length, parts },
  });
  assert(done.status === 200, `${done.status} ${JSON.stringify(done.body)}`);
  assert.equal(done.body.file.size, bigBytes.length, "大小不符");
  bigSpeed = bigBytes.length / 1e6 / ((Date.now() - t0) / 1000);
  console.log(`    ${bigSpeed.toFixed(2)} MB/s`);
});

await step("列目录看到 2 个文件 + 1 个子目录", async () => {
  const r = await call(`/api/list?prefix=${encodeURIComponent(`${DIR}/`)}`);
  assert(r.status === 200, `${r.status}`);
  const names = r.body.files.map((f) => f.name).sort();
  assert(r.body.files.length === 2, `文件数 ${r.body.files.length}`);
  assert(r.body.folders.some((f) => f.name === "子目录"), "缺少子目录");
  console.log(`    ${names.join(", ")}`);
});

await step("下载 40 MiB 文件并校验 SHA-256", async () => {
  const res = await retryFetch(`${BASE}/api/file?key=${encodeURIComponent(BIG)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(res.status === 200, `status ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length === bigBytes.length, `长度 ${buf.length}`);
  assert(sha256(buf) === bigSha, "内容校验失败");
});

await step("Range 请求（206 + 内容一致）", async () => {
  const res = await retryFetch(`${BASE}/api/file?key=${encodeURIComponent(BIG)}`, {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=1000-1999" },
  });
  assert(res.status === 206, `status ${res.status}`);
  assert(res.headers.get("content-range") === `bytes 1000-1999/${bigBytes.length}`, res.headers.get("content-range"));
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length === 1000, `length ${buf.length}`);
  assert(sha256(buf) === sha256(bigBytes.subarray(1000, 2000)), "range 内容不一致");
  const disposition = res.headers.get("content-disposition") || "";
  assert(/inline|attachment/.test(disposition), `disposition=${disposition}`);
  assert(/filename\*=UTF-8''/.test(disposition), `缺少中文文件名编码：${disposition}`);
});

let shareUrl;
await step("分享链接（无需登录）可访问", async () => {
  const r = await call("/api/share", { method: "POST", json: { key: SMALL, hours: 1 } });
  assert(r.status === 200, `${r.status}`);
  shareUrl = r.body.url;
  assert(shareUrl.includes("/api/file"), shareUrl);
  const res = await retryFetch(shareUrl, {}, 5);
  assert(res.status === 200, `share status ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(sha256(buf) === sha256(smallBytes), "分享内容不一致");
});

await step("删除进入回收站（不释放空间）", async () => {
  const before = await call("/api/usage?refresh=1");
  const r = await call("/api/delete", { method: "POST", json: { keys: [SMALL, BIG] } });
  assert(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.trashed === 2, `trashed=${r.body.trashed}`);
  const after = await call("/api/usage?refresh=1");
  assert(after.body.usage.total === before.body.usage.total, "软删除改变了总量");
  assert(after.body.usage.trash >= smallBytes.length + bigBytes.length, "回收站统计不足");
});

await step("从回收站恢复小文件", async () => {
  const trash = await call("/api/trash");
  const entry = trash.body.entries.find((e) => e.origKey === SMALL);
  assert(entry, "回收站找不到条目");
  const r = await call("/api/trash/restore", { method: "POST", json: { ids: [entry.id] } });
  assert(r.status === 200, `${r.status}`);
  const list = await call(`/api/list?prefix=${encodeURIComponent(`${DIR}/`)}`);
  assert(list.body.files.some((f) => f.key === SMALL), "恢复失败");
});

await step("清空回收站并清理测试数据", async () => {
  const purge = await call("/api/trash/purge", { method: "POST", json: { all: true } });
  assert(purge.status === 200, `${purge.status}`);
  const del = await call("/api/delete", { method: "POST", json: { keys: [SMALL, `${DIR}/子目录/`, `${DIR}/`] } });
  assert(del.status === 200, `${del.status}`);
  const purge2 = await call("/api/trash/purge", { method: "POST", json: { all: true } });
  assert(purge2.status === 200, `${purge2.status}`);
  const usage = await call("/api/usage?refresh=1");
  console.log(`    清理后占用 ${usage.body.usage.total} B`);
});

await step("清理历史测试残留", async () => {
  const isLeftover = (name) => /^验收测试-|^curl测试$|^probe-/.test(name);
  const root = await call("/api/list?prefix=");
  const leftovers = root.body.folders.filter((f) => isLeftover(f.name)).map((f) => f.prefix);
  if (leftovers.length) {
    await call("/api/delete", { method: "POST", json: { keys: leftovers } });
    await call("/api/trash/purge", { method: "POST", json: { all: true } });
  }
  const after = await call("/api/list?prefix=");
  const remaining = after.body.folders.filter((f) => isLeftover(f.name));
  assert(remaining.length === 0, `仍有残留：${remaining.map((f) => f.name).join(",")}`);
  const usage = await call("/api/usage?refresh=1");
  console.log(`    清理后占用 ${usage.body.usage.total} B`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败：", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}