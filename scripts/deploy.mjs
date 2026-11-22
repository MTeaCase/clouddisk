/**
 * 一键部署：Worker（API） + Pages（前端 + 同源代理） + 密钥 + API_ORIGIN 环境变量。
 *
 * 用法（PowerShell）：
 *   $env:CLOUDFLARE_API_TOKEN = "..."
 *   $env:CLOUDFLARE_ACCOUNT_ID = "..."
 *   node scripts/deploy.mjs
 *
 * 密钥来源优先级：环境变量 ACCESS_PASSWORD / SESSION_SECRET > .secrets.local
 * 已存在且未变化时不会重复写入（wrangler secret bulk 是覆盖语义，重复执行也安全）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "worker");
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const projectName = "clouddisk";

if (!token || !accountId) {
  console.error("缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0 && !allowFail) {
    console.error(`\n命令失败：${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
  return res.status === 0;
}

function wrangler(args, cwd, opts) {
  return run("npx", ["wrangler", ...args], cwd, opts);
}

async function cf(pathname, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${pathname}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

/* ---------- 1. 密钥 ---------- */
function readLocalSecrets() {
  const file = path.join(root, ".secrets.local");
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

const local = readLocalSecrets();
const secrets = {
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD || local.ACCESS_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET || local.SESSION_SECRET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || local.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || local.R2_SECRET_ACCESS_KEY,
};

if (!secrets.ACCESS_PASSWORD || secrets.ACCESS_PASSWORD.length < 8) {
  secrets.ACCESS_PASSWORD = `clouddisk-${crypto.randomBytes(6).toString("base64url")}`;
  console.log(`已生成新密码：${secrets.ACCESS_PASSWORD}`);
}
if (!secrets.SESSION_SECRET) {
  secrets.SESSION_SECRET = crypto.randomBytes(32).toString("base64url");
  console.log("已生成新的 SESSION_SECRET");
}
fs.writeFileSync(
  path.join(root, ".secrets.local"),
  `ACCESS_PASSWORD=${secrets.ACCESS_PASSWORD}\nSESSION_SECRET=${secrets.SESSION_SECRET}\n`,
  { mode: 0o600 },
);

/* ---------- 2. Worker ---------- */
console.log("\n== 部署 Worker ==");
wrangler(["deploy"], workerDir);

const secretsFile = path.join(workerDir, "secrets.bulk.json");
fs.writeFileSync(secretsFile, JSON.stringify(secrets));
wrangler(["secret", "bulk", secretsFile], workerDir);
fs.rmSync(secretsFile, { force: true });

/* ---------- 3. Pages ---------- */
console.log("\n== 部署 Pages ==");
wrangler(["pages", "project", "create", projectName, "--production-branch=main"], root, { allowFail: true });
wrangler(["pages", "deploy", "web", "--project-name", projectName, "--branch", "main", "--commit-dirty=true"], root);

/* ---------- 4. Pages 环境变量：API_ORIGIN ---------- */
const subdomain = (await cf(`/accounts/${accountId}/workers/subdomain`)).subdomain;
const workerUrl = `https://clouddisk-api.${subdomain}.workers.dev`;
console.log(`\nAPI_ORIGIN = ${workerUrl}`);

try {
  await cf(`/accounts/${accountId}/pages/projects/${projectName}`, {
    method: "PATCH",
    body: JSON.stringify({
      deployment_configs: {
        production: { env_vars: { API_ORIGIN: { value: workerUrl } } },
        preview: { env_vars: { API_ORIGIN: { value: workerUrl } } },
      },
    }),
  });
  // 环境变量变更需要重新部署一次才对新版本生效
  wrangler(["pages", "deploy", "web", "--project-name", projectName, "--branch", "main", "--commit-dirty=true"], root);
} catch (err) {
  console.error("设置 API_ORIGIN 失败（可在控制台手动配置）：", err.message);
}

const project = await cf(`/accounts/${accountId}/pages/projects/${projectName}`);
const pagesUrl = `https://${project.subdomain}`;
console.log(`
=========================================
 部署完成
 前端（对外）：${pagesUrl}
 Worker：      ${workerUrl}
 登录密码：    ${secrets.ACCESS_PASSWORD}
 自检：        ${pagesUrl}/api/health
=========================================
`);