# 云盘 · Cloudflare R2 + Workers + Pages

单人云盘：文件存在你自己的 **Cloudflare R2** 桶里，接口跑在 **Worker** 上，界面托管在
**Cloudflare Pages**，大文件在浏览器与 R2 之间**直连**传输。已部署并通过线上线下验收。

- 中国大陆入口（静态，最快）：**https://mteacase.github.io/clouddisk/**
- 中国大陆入口（静态 + 同源 API）：**https://clouddisk-uv1.pages.dev**
- Worker：`https://clouddisk-api.xiatianyou53.workers.dev`（大陆被 DNS 污染，只作服务端上游）
- 密码 / 会话密钥 / R2 S3 密钥：见 `.secrets.local`（已 gitignore，勿提交、勿外发）
- 托管方案的实测对比（Cloudflare / GitHub Pages / 腾讯 EdgeOne）：见 `docs/托管方案对比.md`

> **请轮换你在对话里贴出的 R2 Access Key**：这对 S3 密钥现在作为 Worker secret 使用
> （签发预签名 URL 必需），但它已经出现在聊天记录里，建议到 R2 控制台新建一套、
> 用 `npx wrangler secret put R2_ACCESS_KEY_ID` 覆盖，然后删掉旧的。

---

## 1. 为什么是这样一套架构（有实测依据）

最初版本让所有流量都经 `浏览器 → Pages 代理 → Worker → R2`。在本机（上海电信）实测：

| 通道 | 上传 | 下载 | 结论 |
| --- | --- | --- | --- |
| 经 `pages.dev` 代理转发 | **约 60 KB/s**（40 MiB 用了 11 分钟） | 40 MiB 传输被中断 | 不可用于大文件 |
| 浏览器 ⇄ `r2.cloudflarestorage.com`（预签名） | **2.3 MB/s**（8 MiB / 3.6 s） | **2.6 MB/s** | 快 20–40 倍，稳定 |
| `*.workers.dev` | 不可达（DNS 污染到 108.160.167.159） | 不可达 | 仅服务端可用 |
| `*.github.io`（Fastly） | 首屏 0.9 s / app.js 1.4 s | 正常 | 静态站最快，当前主力入口 |
| `clouddisk.edgeone.cool`（腾讯全球区） | 国内节点 0.6 s | 401 私有 | 需绑定域名后才公开 |

于是定稿为：

```
                         中国大陆浏览器
                                │
        ┌───────────────────────┴────────────────────────┐
        │ 小请求：JSON / 列表 / 鉴权                       │ 大文件：预签名 PUT / GET
        ▼                                                ▼
┌──────────────────────┐                        ┌────────────────────────┐
│ Cloudflare Pages     │  /api/* 同源代理        │ R2 S3 端点             │
│ functions/api/[[path]]│ ───────────────────────▶│ r2.cloudflarestorage… │
└──────────┬───────────┘                        └───────────┬────────────┘
           │ 服务端转发（CF 内网）                            │ 直连
           ▼                                                 ▼
┌──────────────────────┐                          ┌──────────────────────┐
│ Worker clouddisk-api │ ── R2 binding ──────────▶│ R2 桶 clouddisk      │
│ 鉴权/配额/元数据/分片 │                          │ 10 GiB 自限          │
└──────────────────────┘                          └──────────────────────┘
```

- **元数据与校验**（登录、列目录、配额、回收站、分片初始化/合并）走 Pages → Worker；
- **文件字节**走浏览器 ⇄ R2 预签名 URL，不经过 Worker，也就不受跨境中转瓶颈影响；
- 预签名 URL 由 Worker 用 S3 密钥现签（6 小时有效期，绑定具体对象键）；
- 若 R2 直连不可用（例如桶 CORS 未配置、被网络阻断），前端会**自动回退**到经 Worker 代理的旧通道，功能不丢，只是慢。

`pages.dev` 与 `r2.cloudflarestorage.com` 在中国大陆目前都可达但都不稳定，所以客户端对
网络错误和 5xx 自动重试（2 次退避），上传分片失败只重传该片。

---

## 2. 功能与配额

| 能力 | 说明 |
| --- | --- |
| 登录 | 单用户密码 → HMAC-SHA256 签名令牌（30 天），无 Cookie/无数据库；错误密码限流 |
| 浏览 | 面包屑 + URL 深链 `#/照片/2026/`、列表/网格、按名称/大小/时间排序、分页 |
| 上传 | 拖拽整窗、多选、文件夹上传（保留相对路径）；≤64 MiB 单请求，更大走 16 MiB 分片；进度/速度/失败重试 |
| 下载 | 单文件/多选；≥1 MiB 直接 302 到 R2（视频可拖进度条），小文件 Worker 流式返回 |
| 预览 | 图片/视频/音频/PDF/文本；其余给下载按钮 |
| 分享 | 1 小时 ~ 30 天免登录链接（HMAC 令牌绑定文件），到期自动失效 |
| 重命名 | 文件与文件夹（文件夹递归复制后删除） |
| 回收站 | 删除进 `_trash/`，可恢复/永久删除，每日 03:00（北京时间）清理 30 天前条目 |
| 搜索 | 全桶文件名子串搜索（最多扫描 2 万对象、返回 200 条） |
| 配额 | 10 GiB 硬上限、9.5 GiB 停止上传，按真实对象列表统计（含回收站） |

### 9.5 GiB 停止上传是怎么做到的

1. `POST /api/pm/init`（直传通道）与 `POST /api/upload/init`（代理通道）都先
   `assertCanUpload()`：实时列举对象算总量，`已用 + 本次 > 9.5 GiB` → 直接 `507`，
   **不会签发预签名 URL，也不会写任何字节**。
2. 分片合并后（`/api/pm/complete`）再算一次；若越过 **10 GiB 硬上限**，
   删掉刚合并的对象并返回 `507` 回滚，绝不悄悄突破自限额度。
3. 界面：侧栏进度条（80% 黄/100% 红）、顶部横幅、上传前置检查，
   并提供「清空回收站释放空间」。

回收站占用**计入**配额（账目诚实）；撞线时界面会给出一键清空入口。

---

## 3. 本地开发

```powershell
cd clouddisk

node tests/e2e.mjs                 # 逻辑验收：真实 Worker 源码 + 内存 R2（27 项）
node scripts/dev-server.mjs --seed # 本地预览 http://127.0.0.1:8080（密码 dev-password-1234）
node tests/ui.mjs                  # 真实浏览器交互（12 项，需上面那个服务在跑）
node tests/live.mjs  <url> <密码>   # 线上 API 验收（含 40 MiB 分片 + SHA-256）
node tests/ui-live.mjs <密码>       # 线上浏览器验收（验证直连 R2 真的走通）
```

> 本机 `wrangler dev` 起不来是环境问题：workerd 在 Windows 创建
> `miniflare-email-store` 目录时报 `CreateDirectory: #5 拒绝访问`（4.136 与 4.166 都存在）。
> 所以仓库自带 `scripts/dev-server.mjs`，用 Node 直接调 Worker 的 `fetch` 并注入内存版 R2，
> 功能等价。Linux/macOS 上可直接 `cd worker && npx wrangler dev`。

---

## 4. 部署

一键（幂等）：

```powershell
$env:CLOUDFLARE_API_TOKEN = "..."
$env:CLOUDFLARE_ACCOUNT_ID = "766a7c0d3acf63918d9747bfcf5b4802"
node scripts/deploy.mjs
```

首次部署后还需两步（只需一次）：

```powershell
# 1) 给桶配 CORS，允许浏览器直传/直读（接口内部会保存 CORS 配置）
curl -X POST -H "Authorization: Bearer <登录令牌>" https://clouddisk-uv1.pages.dev/api/admin/cors

# 2) 确认预检通过
curl -i -X OPTIONS -H "Origin: https://clouddisk-uv1.pages.dev" \
     -H "Access-Control-Request-Method: PUT" \
     https://766a7c0d3acf63918d9747bfcf5b4802.r2.cloudflarestorage.com/clouddisk/probe.txt
```

手动分步：

```powershell
cd worker
npx wrangler deploy                       # 发布 Worker
npx wrangler secret bulk secrets.json     # ACCESS_PASSWORD / SESSION_SECRET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
cd ..
npx wrangler pages project create clouddisk --production-branch=main
npx wrangler pages deploy web --project-name clouddisk --branch main
```

Pages 侧配置：环境变量 `API_ORIGIN=https://clouddisk-api.xiatianyou53.workers.dev`，
`web/_routes.json` 限定 Functions 只接管 `/api/*`。

---

## 5. 目录

```
clouddisk/
├─ worker/
│  ├─ src/index.ts     路由与 handlers（含直传通道 /api/pm/*）
│  ├─ src/sigv4.ts     R2 S3 签名：预签名 URL、分片创建/合并、桶 CORS
│  ├─ src/store.ts     R2 数据层：列举/用量/复制/回收站/配额
│  ├─ src/auth.ts      HMAC 令牌、密码校验、登录限流
│  ├─ src/util.ts      响应/CORS/Range/base64url/路径规范化
│  └─ wrangler.toml    R2 binding、限额、S3 端点、每日 Cron
├─ web/                Pages 静态前端（原生 ES 模块，无构建）
│  ├─ index.html · styles.css · app.js · config.js · _headers · _routes.json
├─ functions/api/[[path]].ts   Pages Functions → Worker 同源代理
├─ scripts/{dev-server,deploy,github-publish}.mjs
├─ tests/{e2e,ui,live,ui-live}.mjs + r2-mock.mjs
├─ .github/workflows/pages.yml   GitHub Pages 发布（静态站备用入口）
└─ docs/{中国大陆访问.md,托管方案对比.md,运维手册.md}
```

---

## 6. 已知限制

- 文件夹不支持整包下载（无服务端 zip）；多选下载是逐个触发。
- 搜索是前缀扫描，不是全文索引（2 万对象 / 200 条上限）。
- 不生成图片缩略图（R2 无图片处理，Cloudflare Images 另收费）。
- 重命名文件夹是递归复制 + 删除，大目录偏慢。
- 单文件上限 5 GiB（应用层限制）；刷新页面后不能续传未完成的文件。
- 单用户模型：没有多账号、没有分享权限分级、没有版本历史。

## 7. 成本

R2 每月免费 10 GB 存储 + 1M A 类 + 10M B 类操作，出网免费；Workers/Pages 免费版
10 万请求/天。自限 10 GiB 的情况下通常每月 0 元；超出存储按 $0.015/GB·月。

## 8. 安全

- 所有对象都在私有桶里，只能通过 Worker 签发的短期 URL 或登录令牌访问；
- 会话令牌与分享令牌都是 HMAC-SHA256 签名、带过期时间，服务端无状态；
- 用户上传的 HTML/SVG 一律以 `text/plain` + CSP sandbox 返回，避免同域 XSS；
- 上传大小、分片大小、路径穿越、`Content-Length` 伪造都有服务端校验；
- 登录失败 10 次/5 分钟按 IP 限流（isolate 内存，冷启动会重置）。