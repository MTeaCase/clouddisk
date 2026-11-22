/**
 * 真实浏览器交互测试（Playwright + 本机 Edge），跑在 scripts/dev-server.mjs 之上。
 * 覆盖：登录、目录浏览、上传、预览、搜索、新建文件夹、删除→回收站→恢复。
 *
 * 前置：node scripts/dev-server.mjs --seed 已在 8080 端口运行。
 * 运行：node tests/ui.mjs
 */
import { chromium } from "playwright-core";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080";
const PASSWORD = "dev-password-1234";
const shots = path.resolve(import.meta.dirname, "..", ".shots");
fs.mkdirSync(shots, { recursive: true });

/* ---------- 生成一张真实 PNG（避免依赖外部图片） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const t = x / width;
      raw[o++] = Math.round(30 + 60 * t);
      raw[o++] = Math.round(90 + 110 * (y / height));
      raw[o++] = Math.round(220 - 90 * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const pngPath = path.join(shots, "upload-test.png");
fs.writeFileSync(pngPath, makePng(1200, 750));

/* ---------- 测试 ---------- */
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

console.log("\n[1] 登录与导航");
await step("打开登录页", async () => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#login-view:not([hidden])");
  assert.equal(await page.textContent(".login h1"), "云盘");
  await page.screenshot({ path: path.join(shots, "ui-login.png") });
});

await step("错误密码提示", async () => {
  await page.fill("#password", "definitely-wrong");
  await page.click("#login-submit");
  await page.waitForSelector("#login-error:not([hidden])", { timeout: 5000 });
  assert.match(await page.textContent("#login-error"), /密码错误/);
});

await step("正确密码进入云盘", async () => {
  await page.fill("#password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector("#shell:not([hidden])", { timeout: 8000 });
  await page.waitForSelector("#rows tr");
  const rows = await page.$$("#rows tr");
  assert.ok(rows.length >= 5, `应有 5 个演示文件夹，实际 ${rows.length}`);
});

await step("双击进入文件夹（含面包屑）", async () => {
  await page.dblclick('#rows tr[data-key="设计稿/"]');
  await page.waitForFunction(() => document.querySelectorAll("#rows tr").length === 2);
  assert.match(await page.textContent("#breadcrumb"), /设计稿/);
  await page.screenshot({ path: path.join(shots, "ui-folder.png") });
});

console.log("\n[2] 上传 / 预览");
await step("上传图片并在列表出现", async () => {
  await page.setInputFiles("#file-picker", pngPath);
  await page.waitForSelector('#rows tr:has-text("upload-test.png")', { timeout: 20000 });
  await page.waitForSelector(".upload-item.is-done", { timeout: 20000 });
  await page.screenshot({ path: path.join(shots, "ui-upload.png") });
});

await step("双击打开图片预览", async () => {
  await page.dblclick('#rows tr:has-text("upload-test.png")');
  await page.waitForSelector(".overlay.is-preview");
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview-body img");
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
  await page.screenshot({ path: path.join(shots, "ui-preview.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".overlay.is-preview", { state: "detached" });
});

await step("文本文件按纯文本预览", async () => {
  await page.goto(`${BASE}/#/文档/`, { waitUntil: "networkidle" });
  await page.waitForSelector('#rows tr:has-text("项目计划-2026.md")', { timeout: 10000 });
  await page.dblclick('#rows tr:has-text("项目计划-2026.md")');
  await page.waitForSelector(".preview-body pre", { timeout: 15000 });
  assert.match(await page.textContent(".preview-body pre"), /项目计划/);
  await page.keyboard.press("Escape");
});

console.log("\n[3] 新建 / 搜索 / 删除 / 回收站");
await step("新建文件夹", async () => {
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#rows tr");
  await page.click("#new-folder");
  await page.waitForSelector("#prompt-input");
  await page.fill("#prompt-input", "临时目录");
  await page.click('[data-act="ok"]');
  await page.waitForSelector('#rows tr:has-text("临时目录")', { timeout: 10000 });
});

await step("搜索文件", async () => {
  await page.fill("#search-input", "计划");
  await page.press("#search-input", "Enter");
  await page.waitForFunction(() => {
    const info = document.querySelector("#sort-info")?.textContent || "";
    return info.includes("搜索");
  }, { timeout: 10000 });
  const rows = await page.$$("#rows tr");
  assert.ok(rows.length >= 1);
  assert.match(await page.textContent("#rows tr"), /项目计划/);
  await page.screenshot({ path: path.join(shots, "ui-search.png") });
});

await step("删除进入回收站并恢复", async () => {
  await page.fill("#search-input", "");
  await page.goto(`${BASE}/#/设计稿/`, { waitUntil: "networkidle" });
  await page.waitForSelector('#rows tr:has-text("upload-test.png")');
  await page.click('#rows tr:has-text("upload-test.png")');
  await page.keyboard.press("Delete");
  await page.waitForSelector('.overlay [data-act="ok"]');
  await page.click('.overlay [data-act="ok"]');
  await page.waitForFunction(
    () => ![...document.querySelectorAll("#rows tr")].some((tr) => tr.textContent.includes("upload-test.png")),
    { timeout: 15000 },
  );

  await page.click('[data-nav="trash"]');
  await page.waitForSelector("#rows tr");
  const trashText = await page.textContent("#rows");
  assert.match(trashText, /upload-test\.png/);
  await page.screenshot({ path: path.join(shots, "ui-trash.png") });

  const trashRow = page.locator('#rows tr:has-text("upload-test.png")');
  await trashRow.hover();
  await trashRow.locator('[data-act="restore"]').click();
  await page.waitForSelector(".toast");
  await page.click('[data-nav="files"]');
  await page.waitForSelector("#rows tr");
});

await step("网格视图可切换", async () => {
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.click("#view-grid");
  await page.waitForSelector("#grid .card");
  assert.ok((await page.$$("#grid .card")).length >= 5);
  await page.screenshot({ path: path.join(shots, "ui-grid.png") });
  await page.click("#view-list");
});

await step("无控制台错误", async () => {
  // 故意输错密码会产生一条 401 资源加载日志，属于预期
  const unexpected = consoleErrors.filter((e) => !/401/.test(e));
  assert.deepEqual(unexpected, [], unexpected.join(" | "));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败：", failed.map((f) => f.name).join(", "));

await browser.close();
if (failed.length) process.exitCode = 1;