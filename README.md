# Cloudflare 直播源管理（Pages + KV + Pages Functions）

独立版本，保留密码登录、多直播源、自动清理无效 M3U 条目、更新间隔、手动更新、回滚、自定义订阅地址、30 / 90 / 180 / 360 天及永久有效期。时间以北京时间显示。不限制客户端数量或应用层订阅请求次数。

## 架构

- **Pages**：静态管理页面 `/admin/`，Pages Functions 提供 `/api/*` 与 `/sub/*`。
- **KV**：`LIVE_KV` 保存源配置、当前及上一版列表、订阅、会话和更新记录。
- **Pages Functions**：后端代码随 Pages 项目部署，直接使用项目的 KV 绑定。无需单独创建或部署 Worker。

全部源码在本目录，无需依赖上层 EdgeOne 项目。`functions/` 是 Cloudflare 的函数目录；没有 `edgeone.json`。

## 本地运行

需要 Node.js 22 或更高版本，建议 Node.js 24。在本目录执行：

```powershell
npm install
npm run setup
# 编辑 .env.local 中 ADMIN_PASSWORD（6～1024 个字符）
npm run dev
```

打开 `http://127.0.0.1:8788/admin/`。此模式用本地文件模拟 KV，数据位于 `.local/kv/`，不写入线上。

使用 Cloudflare 本地运行时：

```powershell
Copy-Item .env.local .dev.vars
npm run dev:cf
```

`.dev.vars` 只供 Wrangler 本地开发，已被 Git 忽略。此模式通过命令行创建本地 `LIVE_KV` 绑定，使用 Wrangler 的本地 KV（`.wrangler/`），与上述文件模拟数据和线上数据分别独立。

```powershell
npm test
npm run check:cf
```

`check:cf` 构建静态页面并编译 Pages Functions，不发布线上资源。

## 部署 Pages 和 KV

仓库包含已构建的 `dist/`，Pages 构建命令留空时也可直接部署当前静态页面。仍建议设置 `npm run build`，让后续前端修改自动生成最新输出。修改 `public/` 后，本地运行 `npm run build` 并把更新后的 `dist/` 一起提交。输出目录始终为 `dist`，`functions/` 随 Pages 项目独立编译。

1. 创建 Cloudflare KV 命名空间（例如 `iptv-production`），记录其 ID。可在控制台操作，或登录后执行：

   ```powershell
   npx wrangler login
   npx wrangler kv namespace create LIVE_KV
   ```

2. 在 Pages 项目设置的 Bindings 中添加 KV namespace 绑定，变量名填写 **LIVE_KV**，选择创建的命名空间。不能把 `LIVE_KV` 设置为普通字符串环境变量。
3. 在 Cloudflare Pages 导入 Git 仓库。如果仓库包含上层 EdgeOne 版，**根目录选择 `cloudflare-kv-pages`**；如果只上传此目录内容，根目录为空。框架选择 None，构建命令 `npm run build`，输出目录 `dist`。
4. 在 Pages 项目设置的 Variables and Secrets 中配置以下 **Secrets**（值不加外层引号），用于 Production：

   | 名称 | 内容 |
   | --- | --- |
   | `ADMIN_PASSWORD` | 自己设置的管理员密码，6～1024 个字符 |
   | `SESSION_SECRET` | 至少 32 字符随机密钥，推荐 setup 生成的 64 位十六进制值 |

   可从本地 `setup` 生成的 `.env.local` 复制。登录和手动管理只需要以上两个 Secrets。`CRON_SECRET` 仅在使用下文的外部定时调用时配置。不要将这些值写入源码或 Git。配置后重新部署。
5. 访问 `https://你的域名/api/session`，未登录应返回 **JSON 401**；未绑定 KV 或缺少密钥时返回 JSON 503。访问 `/admin/` 登录，添加直播源，创建订阅 `keting`，播放器地址为 `https://你的域名/sub/keting/playlist.m3u`。

也可用 CLI：先创建 Pages 项目并设置 Secrets，再部署。

```powershell
npx wrangler pages project create iptv-manager
npx wrangler pages secret put ADMIN_PASSWORD --project-name iptv-manager
npx wrangler pages secret put SESSION_SECRET --project-name iptv-manager
npm run deploy:pages -- --project-name iptv-manager
```

上述 `iptv-manager` 替换为实际 Pages 项目名，KV 绑定和 Secrets 在 Pages 控制台设置。必须从本目录运行，Wrangler 才会同时上传 `dist` 和编译 `functions/`。不要在控制台只拖拽上传 `dist`，该方式不会部署 Functions。线上兼容日期可在 Pages 的 Functions 设置中填写 `2026-10-01`。

预览部署应使用单独的 KV 和密钥，避免测试修改生产数据。在启用 Preview 前，在 Pages 控制台配置 Preview 环境的独立 `LIVE_KV` 绑定和 Secrets。不要把生产调度地址改为预览地址。

## 更新方式

新建直播源时立即拉取一次，之后可以在管理页面点击「立即更新」。Pages Functions 没有原生定时触发器，因此只部署 Pages + KV + Functions 时，关闭管理页面后不会按更新间隔自动执行。播放器访问订阅只读取已保存列表。

如需无人值守更新，可由你已有的服务器、NAS、腾讯云 SCF 或支持自定义请求头的定时 HTTP 服务调用 Pages 接口，无需单独部署 Cloudflare Worker。

1. 在 Pages 添加至少 32 字符随机值的 `CRON_SECRET` Secret 并重新部署。
2. 在外部调度器配置每 5 分钟发送一次：

```http
POST https://你的正式域名/api/cron/refresh
Authorization: Bearer <CRON_SECRET>
```

密钥放在请求头，不放在 URL。未配置有效 `CRON_SECRET` 时该接口返回 JSON 503，登录及手动更新正常可用。只设置一个调度器并避免重叠运行。

每轮最多处理 3 个到期源，单个源拉取最长 15 秒，外部调用超时建议至少 60 秒。响应 `results` 包含每个源的成功或失败，`remaining` 表示还在等待的源数；调度器应同时检查 HTTP 状态和 `results[].ok`。失败不覆盖已保存列表，详情在管理页面查看。失败后按源的间隔再次尝试，也可手动更新。

## 配置和运行边界

- `/api/*`、`/sub/*` 的响应由 Functions 设置 `Cache-Control: no-store`；`_headers` 只给静态资源加安全响应头。自定义域名的 Cache Rules 不得对这些接口强制缓存。`_routes.json` 只让 API 和订阅路径触发 Functions，静态页面直接由 Pages 提供。
- Cloudflare Access 如覆盖整个站点，会拦截播放器与外部定时调用；需要按实际访问策略开放 `/sub/*` 与调度接口（调度接口仍用 Bearer 密钥认证）。管理页可另加 Access 保护。
- KV 最终一致，变更通常约 60 秒传播，部分节点可能更久；禁用、删除、改名和会话注销有传播延迟。到期由每次请求检查，无需等待清理任务；客户端已下载的播放地址无法收回。
- KV 不提供事务或原子锁。适合单管理员、单调度器，避免在多个页面同时修改相同记录、同时手动更新和定时更新。Cloudflare 同一 key 每秒最多写一次，快速连续保存、登录失败或重复更新可能触发 429；等待后再操作。应用错误会显示诊断编号。
- 登录限速使用 Cloudflare 的 `CF-Connecting-IP`，每个 IP 15 分钟内累计 5 次失败后暂时拒绝；KV 计数为尽力保护，强保护可加平台访问频率规则。本地没有该请求头时共用 unknown 桶。
- 列表最大 4 MB，当前与上一版同存一个 KV 值，低于 KV 单值 25 MiB 上限。严格 UTF-8 / M3U 校验、清理停用或损坏条目，拒绝 HLS 分片列表；格式有效不代表播放网址一定可用。
- 来源网址仅允许公网 HTTP/HTTPS，检查每次重定向并拒绝直接内网 IP。没有 DNS 解析层拦截，请使用可信来源域名。
- 平台 Pages Functions、KV 的账户额度仍适用，订阅没有应用层次数限制不代表平台额度无限。源、订阅数量增加时会增加 KV 读取；以账户实际配额和日志为准。
- 修改密码：更新 Pages `ADMIN_PASSWORD` 后重新部署；同时轮换 `SESSION_SECRET` 可使旧会话失效。使用外部调度时，轮换 `CRON_SECRET` 需同步 Pages 和外部调用方。
- 无自动数据迁移。此版本首次运行为空；可在管理页面重新添加直播源及订阅。原 EdgeOne 代码和数据不受影响。

## 官方参考

- [Pages Functions 路由](https://developers.cloudflare.com/pages/functions/routing/)
- [Pages Functions 绑定](https://developers.cloudflare.com/pages/functions/bindings/)
- [Pages 本地开发](https://developers.cloudflare.com/pages/functions/local-development/)
- [Pages Functions API](https://developers.cloudflare.com/pages/functions/api-reference/)
- [KV 写入限制和最终一致性](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)

## 多格式来源与订阅

添加来源时可选自动识别、M3U、TXT、JSON，按响应内容识别，与网址后缀无关。来源须为 UTF-8、最大 4 MB。统一转换为 M3U 保存，每个订阅自动提供三条链接：

- `/sub/keting/playlist.m3u`：保留 M3U 扩展元数据。
- `/sub/keting/playlist.txt`：频道名和播放地址，使用 `分组名,#genre#` 表示分组。
- `/sub/keting/playlist.json`：`{ "channels": [...] }`，包含频道名称、地址、分组、台标和频道 ID。

三条链接共用订阅的有效期、启用状态和所绑定来源；管理页面可分别复制。更新、回滚后同时生效。

TXT 示例：

```text
央视,#genre#
CCTV-1,https://stream.example.com/cctv1.m3u8
CCTV-2,https://stream.example.com/cctv2.m3u8
```

JSON 支持直接频道数组或以下结构，name 和 url 必填，group、logo、tvgId 可选：

```json
{
  "channels": [
    {
      "name": "CCTV-1",
      "url": "https://stream.example.com/cctv1.m3u8",
      "group": "央视",
      "logo": "https://example.com/cctv1.png",
      "tvgId": "cctv1"
    }
  ]
}
```

过滤无效频道并记录数量；格式无法识别、JSON 结构不支持、内容超限或没有有效频道时保留旧列表。不同 JSON 接口需要按此结构提供数据。TXT 无法表示台标、频道 ID 和播放器扩展参数；名称与分组中的英文逗号在 TXT 输出时转换为中文逗号。JSON 输出保留五个标准字段，不包含 M3U 的其他扩展参数。保留同名频道的不同播放地址，不自动去重，不检测实际播放可用性。

TVBox JSON 配置可通过 lives[].url 引用明文 M3U/TXT/JSON 直播列表，相对网址以配置地址为基准解析。最多 8 个引用、仅一层；全程共用 15 秒超时和 4 MB 下载上限。不会执行 spider/JAR 或解析 sites 点播站点；加密列表需先提供明文或解密方式。
