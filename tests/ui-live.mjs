/**
 * 线上真实浏览器验收：验证「浏览器 ⇄ R2 直传」在这条网络下确实成立
 * （CORS 预检、ETag 回传、302 下载、进度与列表刷新）。
 *
 * 用法：node tests/ui-live.mjs <password>
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "https://clouddisk-uv1.pages.dev";
const PASSWORD = process.argv[2] || process.env.CLOUDDISK_PASSWORD;
if (!PASSWORD) {
  console.error("缺少密码参数");
  process.exit(1);
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message.split("\n")[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(1200 * (i + 1));
    }
  }
  throw last;
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  acceptDownloads: true,
});
const page = await context.newPage();
const r2Hosts = new Set();
page.on("request", (req) => {
  try {
    const host = new URL(req.url()).host;
    if (host.endsWith("r2.cloudflarestorage.com")) r2Hosts.add(host);
  } catch {
    /* ignore */
  }
});
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const FILE = `live-${Date.now().toString(36)}-12m.bin`;
let token = "";

await step("打开并登录（跨境首屏）", async () => {
  await retry(() => page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 }));
  await page.waitForSelector("#login-view:not([hidden])", { timeout: 60000 });
  await page.fill("#password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector("#shell:not([hidden])", { timeout: 60000 });
  await page.waitForSelector("#rows tr", { timeout: 60000 });
  token = await page.evaluate(() => localStorage.getItem("clouddisk.token"));
  assert.ok(token, "没有拿到令牌");
});

await step("上传 12 MiB（应走浏览器直连 R2）", async () => {
  const buffer = Buffer.alloc(12 * 1024 * 1024, 7);
  await page.setInputFiles("#file-picker", {
    name: FILE,
    mimeType: "application/octet-stream",
    buffer,
  });
  await page.waitForSelector('.upload-item.is-done, .upload-item.is-error', { timeout: 240000 });
  const state = await page.getAttribute(".upload-item", "class");
  assert.match(state, /is-done/, `上传未完成：${await page.textContent(".upload-item")}`);
  assert.ok(r2Hosts.size > 0, "没有观察到直连 R2 的请求（可能回退到了代理通道）");
  console.log(`    直连主机：${[...r2Hosts].join(", ")}`);
});

await step("列表出现新文件且大小正确", async () => {
  const row = page.locator(`#rows tr:has-text("${FILE}")`);
  await row.waitFor({ timeout: 60000 });
  await row.click();
  const cells = await row.locator("td").allTextContents();
  assert.match(cells.join(" "), /12\.0 MB|12 MB|11\.?9 MB/, cells.join(" "));
  await page.screenshot({ path: "D:\\workplace\\clouddisk\\.shots\\ui-live-upload.png" });
});

await step("双击下载（302 到 R2 预签名地址）", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.dblclick(`#rows tr:has-text("${FILE}")`),
  ]);
  assert.match(download.suggestedFilename(), new RegExp(FILE));
  console.log(`    下载文件名：${download.suggestedFilename()}`);
});

await step("删除并清理现场", async () => {
  await page.locator(`#rows tr:has-text("${FILE}")`).click();
  await page.keyboard.press("Delete");
  await page.waitForSelector('.overlay [data-act="ok"]');
  await page.click('.overlay [data-act="ok"]');
  await page.waitForFunction(
    (name) => ![...document.querySelectorAll("#rows tr")].some((tr) => tr.textContent.includes(name)),
    FILE,
    { timeout: 60000 },
  );

  const purge = await retry(() =>
    fetch(`${BASE}/api/trash/purge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }),
  );
  assert.equal(purge.status, 200);
});

await step("无页面脚本错误", async () => {
  assert.deepEqual(consoleErrors, [], consoleErrors.join(" | "));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败：", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await browser.close();