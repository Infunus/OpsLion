# 完整 we-mp-rss 接入与 RSS 协议

公众号采集默认已集成到 **周报 → 公众号采集**，无需安装 RSS，操作见 [前端公众号采集](weread-fetcher.md)。本文仅用于需要完整原版 RSS 管理、定时任务或 RSS 输出的高级接入。

OpsLion 提供完整 [we-mp-rss](https://github.com/rachelos/we-mp-rss) 的启动器和接入代码。采集直接调用原版 `WxGather().Model().get_Articles`，正文使用原版 `sync_article_content`，订阅和文章使用原版数据库，采集任务进入原版 `TaskQueue`。原版 Vue 管理界面、微信授权、订阅管理、采集模式、任务调度、RSS 输出和设置均保留。排版台增加日期范围、进度、取消和资料 ZIP 工作流。

GitHub 发布目录包含接入器，不附带 RSS 源码和个人数据。完整版的 `we-mp-rss/` 放置完整上游源码。当前固定上游提交 `d8feb6a42c6773d7374e03c487d3ae3426084af8`（1.5.3），附加可审查的手动采集进度及微信授权补丁；已验证构建及模拟接口回归，真实采集仍取决于数据源授权和接口可用性。`opslion-rss/v1` 是 OpsLion 的工作流协议，由本仓库的 `scripts/we_mp_rss_server.py` 挂载到完整原版服务，无需另找私有适配器。未接入 RSS 时也能导入周报文案、预览、导出 HTML 和 Bridge 包。

## 安装完整 RSS

准备 Python 3.12、Git 和 Node.js 22.13 或更新版本。在 PowerShell 中取得完整上游源码；已有该版本完整版的 `we-mp-rss/` 时跳过下载：

```powershell
git clone https://github.com/rachelos/we-mp-rss.git D:/services/we-mp-rss
git -C D:/services/we-mp-rss checkout d8feb6a42c6773d7374e03c487d3ae3426084af8
```

在排版台目录执行以下命令，将路径换成实际位置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-rss.ps1 -Source D:/services/we-mp-rss -Runtime D:/private-data/opslion-rss -Python C:/Python312/python.exe
```

脚本建立独立虚拟环境，安装原版全部 Python 依赖及 Firefox、Chromium，应用 `integrations/we-mp-rss/manual-refresh.patch` 和 `wechat-authorization.patch`，通过 `npm ci` 和 `npm run build` 重建完整 Vue 界面，然后初始化运行目录并合并写入本机配置。重复运行可识别已安装补丁；先检查全部补丁兼容性，再修改源码。安装失败时不会切换排版台配置。

进入 **周报 → 原版 RSS（可选） → 重新连接** 后自动启动完整服务，默认 `http://127.0.0.1:8001`。点击 **打开完整 RSS**，在原版界面登录、扫码授权、添加订阅、配置定时任务。新实例的随机管理员密码保存在运行目录 `opslion-admin.json`；迁移实例沿用原来的管理员账号和密码。不要把此文件发给其他人或提交到仓库。

运行目录保存原版 `config.yaml`、`data/`、登录信息、私有静态文件和任务状态；应位于两个源码目录之外。上游会把登录二维码写入 `static/`，启动器因此在运行目录使用静态文件副本。启动器监听本机回环地址；原版的定时采集设置继续有效。关闭排版台页面不会终止独立 RSS 服务。

## 公众号扫码授权

在完整 RSS 页面点击 **扫码授权**，使用微信扫码并在手机上确认。授权浏览器使用普通桌面浏览器请求头，遵循原版 `config.yaml` 的 `proxy.enabled`、`proxy.http_url` 设置。重复点击会复用正在生成或等待扫码的任务。生成失败或二维码过期时，窗口显示具体阶段的错误并提供 **重试**；关闭窗口会停止前端轮询，再次打开可继续尚未过期的授权任务。

升级后重启完整 RSS 服务，在页面按 **Ctrl+F5** 加载新界面。持续提示登录页打开失败或二维码超时时，检查运行目录中的代理配置及其网络连通性。不要把登录二维码、Cookie 或运行日志提交到仓库。

保留原版登录校验及 `/api/v1/wx/auth/qr/code`、`/qr/status` 接口；后者在 `data` 中保留 `login_status`、`qr_code`，并增加 `state`（`idle`、`loading`、`waiting`、`success`、`failed`）和 `error`。前端按状态检查生成和扫码结果，后台失败后不再反复请求不存在的图片；只有有效授权保存完成才报告扫码成功。二维码生成成功不代表文章采集接口已恢复。

## 原版界面的手动采集

打开公众号文章列表，点击 **刷新**。页码从 1 开始，采集第一页填写开始 1、结束 1。提交后显示排队、执行和最终结果，窗口关闭或页面重新打开后仍可查询进度；收到提交响应仅代表任务已接受。接口拒绝无效范围、同一公众号的重复执行；任务使用原版队列，服务重启后未完成任务显示中断。

补丁保留原版身份校验，提供以下原生接口（相对于 `/api/v1/wx/mps`）：

| 接口 | 返回 |
| --- | --- |
| GET `/update/{mp_id}?start_page=0&end_page=1` | 接受任务后返回 `data.task_id`；后端页码从 0 开始，结束页不包含在内 |
| GET `/update/tasks/{task_id}` | `data` 中返回状态、页数、文章处理数和失败说明 |
| GET `/update/latest/{mp_id}` | `data.task` 返回最近一次任务，无任务为 `null` |

`status` 可为 `pending`、`running`、`success`、`failed` 或 `interrupted`。文章处理数包含已存在的文章，不等于新增数。有效空页可完成手动任务；接口报错、正文保存失败或没有取得有效响应时不能显示采集成功。

通过本仓库启动的完整服务中，手动刷新遇到微信 `200013`（频率受限）或 `200003`（授权失效）会停止本次任务并显示错误，避免原版静默等待重试数分钟。该处理由 `scripts/we_mp_rss_manual.py` 接入原版进度观察器；周报日期采集保留下文的可取消重试策略。扫码成功只说明取得新授权，不能证明文章接口已经解除限制。

### 文章目录通道的已知限制

截至 2026-09-14，原版依赖的跨公众号文章目录通道存在持续不可用的报告。[we-mp-rss 上游问题 #456](https://github.com/rachelos/we-mp-rss/issues/456) 记录了 2026-07-31 后“能取得公众号信息，但刷新取不到文章列表”的现象；[另一采集项目的维护说明](https://github.com/Moore-developers/moore-wechat-article-downloader/blob/main/README.md) 将其依赖的列表接口不可用时间记为 2026-07-30。这些是项目维护者和使用者的记录，不是腾讯正式公告，也不能据此断言所有账号永久不可用。

`200013` 的原始含义是 `freq control`，但单凭这个错误码无法判断是短期限流还是持续的目录访问限制。公众号搜索、自有文章列表查询和跨公众号文章目录查询应分别验证：前两项成功不代表后一项可用。持续收到 `200013` 时不要反复扫码、重装或将空结果当作“没有新文章”；有限重试也不保证通道恢复。接入完整原版可以保留其功能和数据，但恢复旧版本不能恢复服务端已经限制的接口。

1.5.3 的 **微信读书管理** 提供独立扫码入口。`weread_mp` 是公众号文章通道，`weread` 是读书笔记通道；公众号后台授权不能替代微信读书授权。使用新通道需先完成对应授权并在完整 RSS 验证文章采集。周报日期范围适配目前覆盖原版 `web`、`app`、`api` 请求格式，微信读书通道的分页及历史覆盖尚待适配和实测，不能据原版手动任务完成便宣称整周资料齐全。

### 独立浏览器采集入口

**周报 → 公众号采集** 已集成浏览器登录、公众号添加、日期采集、正文及配图下载、任务进度和资料 ZIP。采集代码随项目提供，首次所需依赖由前端初始化，无需配置本节的 RSS 服务。新安装的订阅和授权为空；已有本机采集资料可继续使用。详见 [前端公众号采集](weread-fetcher.md)。

## 迁移原有完整实例

在安装命令中增加 `-ImportFrom D:/old/we-mp-rss`，并指定全新的 `-Runtime`。脚本通过 SQLite 备份读取原数据库，将用户、订阅、文章、任务、标签等完整表及授权资料迁移到新运行目录；原实例只读，已有目标运行目录不会被覆盖。迁移工具支持使用 `data/db.db` 的 SQLite 实例；其他数据库请按上游部署方式迁移。

本机初始配置使用 SQLite 并关闭可选 Redis 服务。需要 Redis、代理、通知或其他原版选项时，在完整 RSS 的配置中设置，依赖与使用方法见[上游文档](https://github.com/rachelos/we-mp-rss/blob/main/README.zh-CN.md)。

## 本机配置

安装脚本会生成配置。也可参考 `config/local.paths.example.json` 手动填写；已有文件时只补充 RSS 字段，保留其他配置。

```json
{
  "rss_backend": "we-mp-rss",
  "rss_root": "D:/services/we-mp-rss",
  "rss_data_dir": "D:/private-data/opslion-rss",
  "rss_python": "D:/private-data/opslion-rss/.venv/Scripts/python.exe",
  "rss_url": "http://127.0.0.1:8001"
}
```

- `rss_root` 指向完整上游源码，`rss_data_dir` 指向已初始化的私有运行目录，`rss_python` 指向安装了全部依赖的 Python。目录和文件均须实际存在。
- 自动启动的本地服务只接受 `http://127.0.0.1:端口`；改变端口时填写 `rss_url`。不会结束占用该端口的其他程序。
- JSON 路径使用 `/` 最方便；使用反斜杠时须写成 `\\`。配置使用 UTF-8，允许 BOM。
- 字段均支持大写 `OPSLION_` 前缀环境变量，例如 `OPSLION_RSS_ROOT`，优先于文件配置。修改环境变量后须重启排版台；文件配置每次请求重新读取，保存后在周报点击“重新连接”即可。
- 本机配置由 Git 忽略，公开仓库只包含示例。凭证不要放入示例、README 或接口响应。

已经用本仓库启动器运行服务时，可以仅设置 `rss_backend`、`rss_url` 和 `rss_token_file`，不填写 `rss_root`；这表示连接现有服务、不自动启动。`rss_token_file` 是该服务运行目录 `opslion-token.txt` 的本机副本。远程连接要求 HTTPS；若需远程部署，应在该主机部署原版与此接入层并配置认证反向代理。仅部署裸上游 `main.py` 不会产生 `/opslion/v1/` 接口，连接时会明确提示。

## 其他 RSS 提供者

其他采集项目仍可使用进程协议，配置如下；不要同时填写完整服务的 `rss_root` 或 `rss_url`。设置了完整服务时优先连接完整服务。

```json
{"rss_provider":"D:/my-rss/provider.py","rss_python":"D:/my-rss/.venv/Scripts/python.exe"}
```

`rss_provider` 必须是实现下文协议的 Python 脚本，不能填写上游 `main.py`；省略 `rss_python` 时使用桥接的 Python。原版模式不调用这些自定义扫码或订阅接口，统一打开原版管理界面。

## 进程协议

接入器使用参数数组启动进程，不经 shell 拼接：

```text
<rss_python> <rss_provider> <operation>
```

工作目录为适配脚本所在目录。每次调用是独立进程；需要跨请求保留的任务、扫码会话和数据应由外部模块持久化或交给独立服务。

标准输入为一个 UTF-8 JSON 对象，空输入参数传 `{}`。标准输出必须仅包含一个 JSON 对象，日志写入 stderr。成功退出码为 0；失败使用非零退出码或 `error: true`，并提供可展示的错误：

```json
{"error": true, "message": "授权已过期，请重新扫码"}
```

进程协议单次调用最多 30 秒。前端 RSS 请求等待 35 秒；采集在后台运行，`refresh` 立即返回任务编号。不能让采集子进程继续占用当前调用的 stdout/stderr 管道。查询任务状态不触发新的周报采集或扫码。完整服务首次连接可自动启动，原版已配置的定时任务按原设置运行。

浏览器通过同源 `/local-api` 访问本地桥接（默认 `127.0.0.1:4319`）。以下 HTTP 路由省略 `/local-api`；POST 请求使用 `Content-Type: application/json`，没有参数也发送 `{}`。JSON 响应禁止缓存。

| HTTP 路由 | operation | 输入 | 成功输出 |
| --- | --- | --- | --- |
| GET `/status` | `status` | `{}` | 接入状态与订阅，见下文 |
| GET `/articles` | `articles` | `start_date`、`end_date`、`offset`、`limit`，可选 `mp_id` | `articles`、`count`、`total`、`next_offset` |
| GET `/articles/:id` | `article` | `id`，可选 `ensure_content: true` | `{"article": {...}}`；不存在时 `article: null`，HTTP 404 |
| POST `/refresh` | `refresh` | `start_date`、`end_date`、`mp_ids` | 任务状态，HTTP 202；必须含 `job_id` 与 `running` |
| GET `/refresh/status` | `refresh_status` | `{}` | 当前或最近一次任务状态 |
| POST `/refresh/cancel` | `cancel` | 可选 `job_id` | 停止请求后的任务状态，编号不符时拒绝停止，保留已采集数据 |
| GET `/rss/management` | `management` | `{}` | `auth`、`feeds`、`collecting` |
| POST `/rss/auth/start` | `auth_start` | 可选 `renew: true` | 扫码会话状态 |
| GET `/rss/auth/poll` | `auth_poll` | `session_id` | 扫码会话状态，成功附带 `auth` |
| POST `/rss/auth/check` | `auth_check` | `{}` | `auth` 对象本身 |
| POST `/rss/auth/cancel` | `auth_cancel` | `session_id` | `{"state":"cancelled"}` |
| POST `/rss/auth/logout` | `auth_logout` | `{}` | 清除本机授权后的 `auth` 对象本身 |
| POST `/rss/feeds/resolve` | `feed_resolve` | `url` | 候选公众号信息 |
| POST `/rss/feeds/add` | `feed_add` | `candidate_id` | `ok`、`id`、`already_subscribed` |
| POST `/rss/feeds/update` | `feed_update` | `id`、`action: pause / resume / remove` | `{"ok":true}` |

GET 参数作为字符串传给适配程序；POST JSON 保留原始类型。文章 ID 会解码后传递。`/articles/:id?ensure_content=1` 映射为 `ensure_content: true`，请求外部模块补齐缺失正文。

`GET /assets/proxy?url=...` 是排版台已有的通用图片接口，不调用适配程序；仅代理获准的微信和秀米图片域名。其他图片源或失效图片会出现在资料 ZIP 的缺失清单中。

## 状态与能力声明

`status` 必须声明精确协议版本、布尔 `available` 和 `feeds` 数组。未接入时桥接自身返回 `available: false`，不会运行采集程序。

```json
{
  "protocol": "opslion-rss/v1",
  "available": true,
  "management_version": 1,
  "feeds": [{"id":"demo-feed","mp_name":"示例公众号","status":1}],
  "totals": {"article_count": 1},
  "refresh": {"running":false,"return_code":null},
  "auth": {"state":"unverified","authenticated":false,"message":"请先完成授权"}
}
```

协议版本不符时拒绝接入。`available: true` 表示模块可用，不等同于微信已授权。读取已有推文可在授权过期时继续；需要登录的操作由模块明确返回错误。

基础 v1 应提供文章读取、日期采集、任务查询和取消。完整原版声明 `engine: "we-mp-rss"`、`management_mode: "native"`、`management_url: "http://127.0.0.1:8001"`，前端显示“打开完整 RSS”。`engine_version`、`gather_mode` 标明实际服务版本和采集模式。接口密钥仅在本地桥接和完整服务之间使用，不返回浏览器。

其他提供者支持全部内嵌管理及扫码操作时才声明 `management_version: 1`。没有原版入口且未声明内嵌管理能力时禁用“管理公众号”。可选 `message` 用于显示模块状态。`status.refresh` 可省略，前端会查询 `/refresh/status`。

## 日期、分页与正文

- 起止日期为 `YYYY-MM-DD`，包含两端，统一北京时间。查询与采集使用 `[开始日 00:00, 结束日次日 00:00)`。
- `mp_ids: []` 表示全部启用订阅；周报“采集并导出 ZIP”总是使用此值。“导出已有推文 ZIP”读取该日期内全部已有文章，不受订阅是否暂停影响。
- `articles` 返回稳定分页，`offset` 从 0 开始，当前界面请求 `limit: 500`。`next_offset` 为下一页位置，结束为 null。前端读取全部分页并按 ID 去重；提供 `total` 时必须与最终唯一文章数一致。
- 公众号字段：`id`、`mp_name`、`status`（1 为启用）；可附带 `update_time`、`article_count`、`url_count`、`content_count`。
- 文章字段：`id`、`mp_id`、`account_name`、`title`、`source_url`、`publish_time`（秒级时间戳），可附带 `description`、`content_preview`、`pic_url`、`has_content`。详情额外返回 `content`，内容为完整正文 HTML。
- 正文缺失时返回可展示的错误，不能用摘要代替全文；补抓失败不能覆盖已有正文。

```json
{
  "articles": [{
    "id":"demo-article","mp_id":"demo-feed","account_name":"示例公众号",
    "title":"示例活动","source_url":"https://mp.weixin.qq.com/s/example",
    "publish_time":1788235200,"has_content":1
  }],
  "count":1,"total":1,"next_offset":null
}
```

## 采集任务

无任务时返回 `{"running":false,"return_code":null}`。开始采集即分配唯一 `job_id`，任务结束后仍保留相同编号和原始日期、订阅范围。

```json
{
  "job_id":"example-job","running":false,
  "start_date":"2026-09-01","end_date":"2026-09-07","mp_ids":["demo-feed"],
  "return_code":0,"outcome":"complete","message":"所选日期采集完成"
}
```

只有 `running: false`、`return_code: 0`、`outcome: "complete"` 才触发待办任务的自动打包。失败、部分完成或取消时使用其他 `outcome`（例如 `failed`、`partial`、`cancelled`）并说明原因。`message` 会展示在周报界面；可附带 `started_at`、`current_feed`、`feed_completed`、`feed_total`、`results` 等细节。

采集需翻页到开始日期之前或数据源结束，检查多图文的子文章日期，重复文章去重；不能因为遇到已存在的文章而提前结束。授权失效、频率限制、重复页、正文失败或任务意外退出必须如实报告。取消应尽快生效，保留已有数据。

完整原版接入层逐页调用原版采集器并观察请求结果。遇到微信 `200013` 时最多等待 60 秒、120 秒重试同页，等待期间可取消；接入层统一管理这些重试，避免与原版内部重试叠加。持续受限则停止后续公众号并设置 120 秒冷却，不宣称成功。`200003` 表示授权失效。任务重启中断、未知响应、保存失败、分页重复、达到页数上限或缺失正文都不能成为 `complete`。停止排队任务立即生效，停止执行中任务在当前原版调用返回后生效；不会清空原版其他任务的队列。

前端保存待导出的任务编号与原始日期，重新进入周报后继续查询。任务丢失、被替代或未完整完成时不自动下载。用户可取消自动导出；这与“停止采集”分别处理。

## 自定义提供者的扫码与订阅

本节仅适用于 `management_version: 1` 的提供者。完整 we-mp-rss 的扫码和订阅由原版页面及原版 API 实现。

`auth` 对象：`state: authorized / expired / unverified / logged_out`、布尔 `authenticated`、`message`，可附带 `nickname`、`expires_at`、`checked_at`（秒）。

扫码状态：`state: waiting / scanned / authorized / expired / blocked / cancelled`，附带 `session_id`、`qr_data_url`、可选 `expires_at` 和 `message`。二维码仅接受 PNG/JPEG 的 base64 data URL。成功时附带 `auth`，不再显示二维码。关闭管理弹窗后前端停止轮询，并取消对应 `session_id`；旧会话不得取消其他窗口的新会话。

`management.feeds` 条目包含 `id`、`mp_name`、`alias`、`status`、`article_count`。`feed_resolve` 返回 `candidate_id`、`mp_name`、`alias`、`article_title`、`subscribed` 和可选 `feed_id`。用户核对名称后，前端仅将候选 ID 交给 `feed_add`；模块应验证其有效期与所属公众号。

暂停订阅后不得继续采集该公众号；移除订阅保留文章，重新添加时可恢复订阅。采集期间模块须拒绝更改订阅以及清除或替换授权，不能只依赖前端禁用按钮。清除授权不删除订阅或文章。

登录令牌、Cookie、账号密码仅由外部模块保存，不能返回到前端、写入浏览器草稿或资料 ZIP，也不要在错误说明中泄露。具体扫码资格与采集限制以数据源的要求为准；完成授权不代表所有历史文章一定可采集。

## ZIP、文案与成稿

资料 ZIP 在浏览器生成并下载，不写入仓库，包含：

```text
README.md
manifest.json
index.json
asset-index.json
all-articles.md
articles/000001-标题.md
articles/000001-标题.html
assets/000001.png
```

`manifest.json` 使用 `opslion-rss/archive-v1`，记录日期、时区、数量与 `issues`。`archive_complete` 表示已列出的正文、原文链接和配图均已打包；`collection_coverage_confirmed` 仅在成功任务的日期吻合且覆盖全部当前启用订阅时为 true。这两项不能互相替代。缺失项会阻止自动下载，用户可查看清单后下载现有资料。

图片按 URL 去重，文件引用替换为包内路径；单图上限 12 MB，配图总量上限 256 MB。成稿需要在线配图地址时使用 `asset-index.json` 的 `source_url`，不能将离线 `assets/` 路径直接写入文案。

处理好的周报文案使用 Hello Week v1 约定的 UTF-8 `.md` / `.markdown` / `.txt`，单文件最多 10 MB。导入按原文保存在浏览器，周报模板负责解析和预览；格式不符时保留原稿并提示修正。成功排版后可下载成品 HTML 和 `*.xiumi.json` Bridge 包。不需要把周报放进普通文章编辑台。

## 接入检查

1. 完成安装，进入周报点击“重新连接”。完整服务应显示“已接入”和“打开完整 RSS”；打开后是原版的登录与管理界面。
2. 先导出一小段已有日期数据，检查全文、图片、原文链接和分页数量；查看 ZIP 中两项完整性标记。
3. 模块支持管理时验证扫码、过期、关闭会话、识别后添加、暂停恢复与移除；无需将任何凭证交给 OpsLion。
4. 再验证日期采集、取消、部分失败和刷新后继续任务。自动测试使用合成数据，不访问微信或真实采集库；真实采集以界面返回结果为准。

“尚未接入 RSS”表示未配置提供者或完整服务。缺少依赖时重新执行安装脚本；启动日志位于 `rss_data_dir/opslion-service.log`。提示接口密钥不符时检查 `opslion-token.txt`；提示未加载 OpsLion 接口时检查启动入口。微信限流与登录失效会显示原始错误码，服务启动成功不代表微信一定允许采集。
