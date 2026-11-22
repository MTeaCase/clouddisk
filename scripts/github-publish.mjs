/**
 * 用 GitHub API（而不是 git push）发布仓库并构建 GitHub Pages。
 *
 * 背景：在这条中国大陆网络上 `github.com:443` 不可达（git push 会挂），
 * 但 `api.github.com` 与 `*.github.io` 都可用，所以改用 Git Data API 建提交，
 * 由 GitHub Actions 负责构建 Pages。
 *
 * 用法：
 *   $env:GITHUB_TOKEN = "ghp_..."
 *   node scripts/github-publish.mjs [repoName]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.GITHUB_TOKEN;
const repoName = process.argv[2] || "clouddisk";
if (!token) {
  console.error("缺少 GITHUB_TOKEN");
  process.exit(1);
}

const API = "https://api.github.com";
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  ".shots",
  ".edge-profile",
  ".data",
  "dist",
]);
const EXCLUDE_FILES = new Set([
  ".secrets.local",
  ".dev.vars",
  ".worker-bundle.mjs",
  ".dev-bundle.mjs",
]);
const MAX_BYTES = 60 * 1024 * 1024;

async function gh(pathname, init = {}, { allow404 = false } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clouddisk-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok && !(allow404 && res.status === 404)) {
    throw new Error(`${init.method || "GET"} ${pathname} → ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: json };
}

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && !entry.name.startsWith(".github")) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (entry.name === ".git" || entry.name === ".wrangler" || entry.name === ".shots") continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      if (rel.startsWith("worker/node_modules")) continue;
      collect(full, out);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (/\.(log|tmp)$/.test(entry.name)) continue;
      const size = fs.statSync(full).size;
      if (size > MAX_BYTES) continue;
      out.push({ rel, full, size });
    }
  }
  return out;
}

const user = (await gh("/user")).body;
console.log(`GitHub 账号：${user.login}（${user.plan?.name || "?"}）`);

const repoRes = await gh(`/repos/${user.login}/${repoName}`, {}, { allow404: true });
let repo = repoRes.status === 200 ? repoRes.body : null;
if (!repo) {
  console.log(`创建仓库 ${repoName}…`);
  repo = (
    await gh("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: repoName,
        description: "个人云盘：Cloudflare R2 + Workers + Pages（静态站可由 GitHub Pages 承载）",
        private: false,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      }),
    })
  ).body;
} else {
  console.log(`仓库已存在：${repo.html_url}`);
}

const headCheck = await gh(`/repos/${user.login}/${repoName}/commits?per_page=1`, {}, { allow404: true }).catch(
  () => ({ status: 409, body: null }),
);
if (headCheck.status !== 200) {
  // Git Data API 对空仓库会返回 409，先用 Contents API 落一个初始提交
  console.log("仓库为空，写入初始提交…");
  await gh(`/repos/${user.login}/${repoName}/contents/.gitkeep`, {
    method: "PUT",
    body: JSON.stringify({ message: "init", content: Buffer.from("").toString("base64") }),
  });
}

const files = collect(root);
console.log(`准备上传 ${files.length} 个文件…`);

const blobs = [];
for (const f of files) {
  const content = fs.readFileSync(f.full);
  const res = await gh(`/repos/${user.login}/${repoName}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
  });
  blobs.push({ path: f.rel, mode: "100644", type: "blob", sha: res.body.sha });
}

const tree = (
  await gh(`/repos/${user.login}/${repoName}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ tree: blobs }),
  })
).body;

const mainRef = await gh(`/repos/${user.login}/${repoName}/git/ref/heads/main`);
const parents = mainRef.status === 200 ? [mainRef.body.object.sha] : [];

const commit = (
  await gh(`/repos/${user.login}/${repoName}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: "deploy: 云盘前端与 Worker 源码",
      tree: tree.sha,
      parents,
    }),
  })
).body;
console.log(`提交 ${commit.sha.slice(0, 8)} 完成`);

if (parents.length) {
  await gh(`/repos/${user.login}/${repoName}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
} else {
  await gh(`/repos/${user.login}/${repoName}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
  });
}

// 开启 Pages：由 Actions 工作流发布
const pagesRes = await gh(`/repos/${user.login}/${repoName}/pages`, {
  method: "POST",
  body: JSON.stringify({ build_type: "workflow" }),
});
if (pagesRes.status === 201 || pagesRes.status === 200) {
  console.log(`Pages 已启用：${pagesRes.body.html_url || ""}`);
} else if (pagesRes.status === 409) {
  console.log("Pages 已经是启用状态");
} else {
  console.log(`Pages 启用返回 ${pagesRes.status}：${JSON.stringify(pagesRes.body).slice(0, 200)}`);
}

console.log(`\n仓库：https://github.com/${user.login}/${repoName}`);
console.log(`站点（构建完成后）：https://${user.login}.github.io/${repoName}/`);
console.log("工作流状态可用 GET /repos/:owner/:repo/actions/runs 查询。");