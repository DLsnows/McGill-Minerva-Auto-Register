# E · API 契约与安全性 — 对抗性验证后报告

> 验证者：对抗性审计（逐条独立打开被引用的文件与行号复核，并用真实 `buildServer` / `Scheduler` 在本机跑复现脚本）
> 目标仓库（只读，未改动任何文件）：`C:/Users/lenovo/deepseekHarness/Auto-Register/wt/audit`（复核前后 `git status --porcelain` 均为空；所有复现脚本写在 `%TEMP%\audit-verify\` 下）
> 原始报告：`audit-findings/E-api-security.md`（8 条发现）
> 环境：Node v24.5.0（仓库 `engines.node >= 22`）· fastify 5.8.5 · @fastify/websocket 11.2.0 · zod 3.x

## 验证方法

1. **逐行复核引用**：8 条发现引用的 20 余处 `file:line` 全部打开确认（`scheduler.ts` / `session-manager.ts` / `api/main.ts` / `api/server.ts` / `store/store.ts` / `server.test.ts` / `shared/store-types.ts`），并向上游追守卫（`runOnce` 的 try/finally、`runCycle` 的 try/catch 覆盖范围、`app.register` 顺序、Fastify 默认 content-type parser）。
2. **实测而非推断**（脚本仅读仓库文件，产物写在系统临时目录）：
   - 用真实 `Scheduler` + 会抛错的 `SessionGuard` 起定时器 → 子进程退出码与栈；
   - 用真实 `buildServer` 注入请求：content-type 矩阵、伪造 `Host`/`Origin`、`limit` 各种取值、纯空白 target、`/api/settings` 回显、WS 握手（真实 TCP + 敌意 `Origin`）；
   - 用真实 `Store` 复现「备份失败 → 空数据启动 → 覆盖原文件」；
   - `node -e` 验证 `slice(-0)` 语义。
3. **对照显式设计意图**：`docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md`、`2026-06-01-autoregister-design.md`、`docs/EMAIL_SETUP.md`、`.gitignore`、`README.md`。
4. **浏览器侧可达性**（影响定级）：核对 Chrome 官方 Local Network Access 文档（`fetch`/子资源/子框架导航被权限门控；**WebSocket 尚未被门控**；权限仅限安全上下文；公网域名解析到本地地址**不**获得混合内容豁免）。来源：[Chrome for Developers — New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)。

**结论概览**：`confirmed` 5 条 · `downgraded` 3 条 · `refuted` 0 条 · `new` 0 条 → **保留 8 条**（critical 1 · medium 4 · low 3）。

**总体判断**：原报告的技术事实几乎全部对得上（唯一一处行号偏差是 `scheduler.ts:315` 应为 314-316），最重的一条经独立复现**完全成立**。真正需要纠正的是**定级**：三条 high/medium 的严重度建立在一个未加限制的前提上——「无鉴权 = 任意页面可读写」。该前提在本仓库是被显式声明为非目标的本地单用户设计，且在现代 Chrome 上 DNS rebinding 读取路径已被 Local Network Access 权限门控；而**不依赖任何权限提示**的 CSRF 写路径（表单顶层导航）与 WebSocket 读取路径反而被原报告排在更后面。此外原报告有一处表述需修正（`data/` 已 gitignore，且 `EMAIL_SETUP.md` 明文写了凭据存在本地数据文件里）。

---

## Confirmed（证据成立，严重度维持）

### [critical] 调度器 tick 的异常无人接管：一次 `isLoggedIn()` 抛错即未处理 rejection，整个 Node 进程退出

- **位置**: `packages/server/src/scheduler/scheduler.ts:105, 311-317, 330-338, 80-91`、`packages/server/src/session/session-manager.ts:29-31, 34-37, 56-60`、`packages/server/src/api/main.ts:7-17`（全仓无兜底）
- **触发路径（已复现，非推断）**:
  - `runCycle` 中唯一无保护的 await 就是 `if (!(await this.deps.session.isLoggedIn()))`（:105）；`checkCourse`（:120-127）与 `actor.act`（:182-189）都有 try/catch，唯独会话探测没有。
  - 抛错源真实：`isLoggedIn()` → `checkStatus()` → `page.goto(PROTECTED_PROBE_URL, …)`（session-manager.ts:56-58）没有 `.catch`，断网/超时即 reject；用户关掉 Chromium 窗口时 `context.on('close')` 把 `this.context` 置 null（:29-31），下一次 `requireContext()` 抛 `SessionManager not launched — call launch() first`（:34-37）。
  - 冒泡链无 catch：`runCycle` → `runOnce`（只有 try/finally，:86-90）→ `tick()` 的 `await this.runOnce(t.id)`（:336）→ `void this.tick().finally(...)`（:314-316，finally 不消费异常）→ 未处理 rejection。
- **证据（本次实测）**: 用真实 `Scheduler` + `isLoggedIn()` 抛 `SessionManager not launched — call launch() first` 的假守卫、`start(20)` 起定时器，子进程输出：
  ```
  [child] exiting with code 1
  Error: SessionManager not launched — call launch() first
      at Object.isLoggedIn (sched-crash.ts:41:13)
      at Scheduler.runCycle (.../scheduler.ts:105:35)
      at Scheduler.runOnce (.../scheduler.ts:87:18)
      at Scheduler.tick (.../scheduler.ts:336:18)
      at Timeout._onTimeout (.../scheduler.ts:314:17)
  ```
  脚本里的 `setTimeout(() => console.log('STILL ALIVE after 1500ms'), 1500)` 从未打印。全仓 grep `unhandledRejection|uncaughtException` **零命中**（`main.ts` 也没有），无 supervisor。行号修正：原报告引用的 `scheduler.ts:315` 实为 314-316。
- **可达性（本次独立核对，写清边界）**: `tick()` 只处理 `status==='watching' && (nextPollAt ?? 0) <= now` 的目标（:332-334），所以崩溃需要「有目标在监控」。这一点被两处放大：
  1. 前端「是否已登录」的闸门依赖服务端 `sessionStatus` 变量（`api/server.ts:83,175`），而它**与真实浏览器上下文解耦**——关掉 Chromium 窗口后 `sessionStatus` 仍是 `'authenticated'`，直到用户恰好打开 Session 页（只有 `status==='logging-in'` 时才会 3 秒轮询，`web/src/pages/Session.tsx:41-55`）。于是 `Dashboard.tsx:72,107-108` 的守卫拦不住这个崩溃状态，用户点「Start all」后 ≤30 秒进程死亡。
  2. `POST /api/scheduler/start|start-all` 不检查会话是否 `launch()` 过（server.ts:188-203）；配合下面的 CSRF 条目，这是**无需任何本地操作**的远程杀进程原语。
- **比原报告更宽的一点**: 崩溃并非只由 `isLoggedIn()` 引起——`runCycle` 里 `store.updateTarget`/`appendEvent`（：139、:72 → `store.save()` 的 `writeFileSync`，store.ts:84-88）同样无保护，磁盘满/被杀软占用/权限错误也会走同一条未处理 rejection 路径把 API 一起带走。
- **修正原报告**: 「UI 仍显示 authenticated」成立（已核实上述轮询条件），「代码本意的『暂停该课程并提示重新登录』分支被完全绕过」也成立——第 105-109 行的暂停分支只在 `isLoggedIn()` **正常返回 false** 时执行，抛错时根本走不到。
- **建议**: 定时器回调 `this.tick().catch(...)`（记 error 事件后继续下一轮）；`tick()` 内对每个 `runOnce` 单独 try/catch（一个课程失败不拖垮其它课程）；把 `isLoggedIn()` 的异常按「会话不可用」处理（等同返回 false 的暂停 + 提示重新登录）；再在 `api/main.ts` 注册 `process.on('unhandledRejection')` 兜底日志。

### [medium] 跨站表单即可驱动调度器（CSRF）：无 Origin/CSRF 防护，且无 body 的 POST 不需要预检

- **位置**: `packages/server/src/api/server.ts:115, 162, 188, 198, 205`（均不读 body）
- **触发路径（已实测 content-type 矩阵）**: 用户开着应用访问任意 `http(s)` 页面，该页自动提交 `<form method=POST enctype="text/plain" action=http://127.0.0.1:4575/api/scheduler/stop-all>`，或用 `navigator.sendBeacon` 到同地址。用 fastify 5.8.5 实测（本机）：
  ```
  start  | 无 body / 无 content-type        -> 200 {"running":true}
  start  | text/plain                       -> 200 {"running":true}
  start  | text/plain;charset=UTF-8         -> 200 {"running":true}
  start  | application/x-www-form-urlencoded-> 415 FST_ERR_CTP_INVALID_MEDIA_TYPE
  start  | multipart/form-data              -> 415 FST_ERR_CTP_INVALID_MEDIA_TYPE
  ```
  `text/plain` 是 CORS 安全列表类型 → 不触发预检；无 body 的 POST 也是简单请求。UI 从不使用 text/plain，所以这条路径**只有跨站攻击者会走**，可作为额外检测信号。
- **影响（比原报告更重）**:
  1. `stop-all` 把所有 `watching` 改 `paused` 并 `scheduler.stop()`（:205-210），`start-all` 把 `paused` 全恢复 `watching` 并启动引擎（:198-203，状态立即落盘 `store.json`）；
  2. **与上一条 critical 联动 = 远程杀进程**：跨站 `POST /api/scheduler/start-all` 在「会话从未 launch」（新装用户还没点登录）或「Chromium 窗口已被关掉」时，会在 ≤30 秒内触发未处理 rejection，把 REST + WS + 轮询一起打掉；
  3. `POST /api/session/login`（:162）同样无 body → 跨站请求可在用户机器上**弹出一个 Chromium 窗口**并开始登录流程（副作用可见但很小，属骚扰/资源占用）。
- **精确化（原报告未提，但会影响修复方案）**: `/api/targets`（POST）与 `/api/settings`（PUT）**不可**被这种 CSRF 打到——它们要 JSON 对象：`text/plain` 的 body 被解析成字符串，zod 直接 400；而真 `application/json` 会触发预检（服务端无 CORS 头 → 浏览器拦截）。跨站能盲写的恰好是那 5 个不读 body 的 POST。「五个端点」这个说法对得上（第 5 个是 `POST /api/targets/:id/run`，:115），但它的 id 是 UUID、不可猜，实际价值≈0；原报告列出的 4 个行号是对的。
- **可达性（浏览器侧，本次核实）**: Chrome 的 Local Network Access 第一里程碑门控的是 `fetch()`、子资源加载与**子框架导航**；跨站**顶层表单导航**不在其中，所以这条路径不需要用户授予任何权限即可生效（`127.0.0.1` 本身是 potentially trustworthy，顶层导航也不受混合内容拦截）。用 iframe 变体则在 Chrome 142+ 会被 LNA 拦，改用顶层表单即可绕过。
- **建议**: 所有写接口要求 `Content-Type: application/json`（跨站简单请求无法无预检地设置），或在 `onRequest` 统一校验 `Origin`/`Host`，并补 `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'`（当前完全没有，本地 UI 可被任意站点 iframe 套用做点击劫持）。

### [medium] WebSocket `/api/stream` 不校验 Origin：任意页面可跨站订阅全部事件

- **位置**: `packages/server/src/api/server.ts:236, 244`、`node_modules/@fastify/websocket/index.js:79`
- **触发路径（已用真实 TCP + 敌意 Origin 实测）**: 任意 `http://` 页面执行 `new WebSocket('ws://127.0.0.1:4575/api/stream')`。对真实 `buildServer`（监听 127.0.0.1 真实端口）用 `ws` 客户端握手的结果：
  ```
  Origin=http://evil.example.com  -> OPEN + snapshot received: {"type":"recent","events":[{"level":"info","message":"CRN 1814 COMP 551 — poll decision: N…
  Origin=https://attacker.test    -> OPEN + snapshot received: …
  Origin=(none)                   -> OPEN + snapshot received: …
  ```
  服务端随后立即推送最近 200 条事件快照（:240）并持续广播（`broadcast`，:266-276）。插件侧确认无任何校验：`@fastify/websocket` 11.2.0 只做 `ws.setSocket(clientStream, head, { maxPayload: 0 })`，无 `verifyClient`/`origin` 选项；全仓 grep `origin|Origin|verifyClient` 零命中。
- **影响**: 泄露课程/CRN/学期、每轮决策原因、注册结果与错误文本（例如 `scheduler.ts:134` 的 CRN not found 文案）——即用户选课监控行为与结果的实时流。不含 SMTP 凭据（事件里没有 settings，`Notifier` 也不写 pass）。
- **可达性（本次核实，需修正原报告一处）**: 原报告写「https 页面会被混合内容策略拦住」——这点随浏览器/版本而异，且**不构成本条的前提**：`http://` 页面路径已实测可用。更关键的是，Chrome 的 LNA 文档明确列出 **WebSocket 连接尚未被权限门控**（"WebSockets … are not yet gated on the LNA permission"），所以在 DNS rebinding 读取（下一条）已被 LNA 提示拦下的现代 Chrome 上，**WS 反而是唯一不需要任何用户授权、也不弹提示的远程读取通道**。这也是本条维持 medium、而 rebinding 那条降到 medium 的依据。
- **建议**: 在升级握手时校验 `Origin`（只允许应用自身来源），用 `@fastify/websocket` 的 `verifyClient` 或复用同一条 `onRequest` Host/Origin 钩子；顺带给 `maxPayload` 设一个有限值（当前为 0 = 不限，恶意页面可发超大帧）。

### [low] `GET /api/events?limit=0` 返回整个日志（`slice(-0)`），而声称覆盖它的测试是空跑

- **位置**: `packages/server/src/api/server.ts:213-219`、`packages/server/src/store/store.ts:157-159`、`packages/server/src/api/server.test.ts:121-124`
- **触发路径（已对真实 `buildServer` 实测，seed 了 2 条事件）**:
  ```
  GET /api/events?limit=0   -> 200 [{"message":"EVENT-1"...},{"message":"EVENT-2"...}]
  GET /api/events?limit=    -> 200 [同上]   # Number('') = 0
  GET /api/events?limit=-5  -> 200 [同上]   # Math.max(0,-5) = 0
  ```
  `recentEvents(limit) { return this.data.events.slice(-limit); }`（store.ts:158）；`[1,2,3].slice(-0)` → `[1,2,3]`（`node -e` 实测）。上限是 2000 条（`maxEvents`），所以「请求 0 条拿到整份日志」成立。原报告只点了 `0` 与空串，实际 `limit<=0` 的任何取值（含负数）都同病。
- **测试确为空跑**: `server.test.ts:121-124` 的 `it('uses limit=0 as zero (not 200)')` 没有 seed，`beforeEach`（:27-30）每次都新建临时目录 + 空 `Store`，`[]` 无论如何都成立——与我实测的「有事件时返回全部」正好相反，回归时不会红。
- **与注释冲突（设计意图）**: :216-217 明确承诺 “negatives clamp to 0; **an explicit 0 is honoured**”，实现与之相反。
- **建议**: `limit<=0` 直接 `return []`（store 内同样判断），并把该用例改成先 `appendEvent` 再断言 `[]`；顺便补一个负数用例。

### [low] `POST /api/targets` 对纯空白必填字段返回 500，而不是 400

- **位置**: `packages/server/src/api/server.ts:40-48, 95-99`、`packages/server/src/store/store.ts:102-106`
- **触发路径（已实测）**: `POST /api/targets` + `{"term":" ", "subject":"COMP", "faculty":"Faculty of Science", "courseNumber":"551", "targetCrn":"1814", "mode":"auto"}` →
  ```
  500 {"statusCode":500,"error":"Internal Server Error","message":"addTarget: missing required field \"term\""}
  ```
  逐跳核对：`term: z.string().min(1)`（:41）接受 `" "` → `deps.store.addTarget(parsed.data)`（:98）同步抛出 → 路由无 try/catch → Fastify 默认错误处理返回 500，并把内部实现信息（字段名 + 函数名）回给调用方。把空白放在 `targetCrn` 上同样 500。
- **修正原报告**: 「Web 表单会先 trim 所以 UI 撞不到」成立——`web/src/components/CourseForm.tsx:64-78` 对五个必填字段逐个 `.trim()` 后判空。因此这只影响脚本/第三方客户端，危害有限，维持 low。
- **建议**: 五个必填字段改成 `z.string().trim().min(1)`（zod 阶段即 400），或把 store 的校验错误映射成 400；顺便考虑给 store 的自定义错误加一个 `statusCode`。

---

## Downgraded（成立但严重度降低）

### [high → medium] 无鉴权的本地 API 不校验 Host/Origin：DNS rebinding 可读到 SMTP 密码与全部状态

- **位置**: `packages/server/src/api/main.ts:15`、`packages/server/src/api/server.ts:82, 128`（全仓无 `onRequest`/`preHandler`/`addHook`/CORS/Host 校验，grep 零命中）
- **成立的部分（全部已实测/核对）**:
  - 绑定 `await app.listen({ host: '127.0.0.1', port: PORT })`（main.ts:15），确无鉴权；
  - `const app = Fastify({ logger: false })`（server.ts:82），无 `@fastify/cors`、无 helmet、无 Host 校验；
  - 伪造头部直接打到真实 `buildServer`：`Host: evil.example.com:4575` + `Origin: http://evil.example.com:4575` → `GET /api/settings` **200 并回显全部设置**；
  - 因此「页面与 `http://<域名>:4575` 同源 → 无 CORS 约束 → 可读 `/api/settings`、`/api/targets`、`/api/events`、可写」这条链在协议层完全成立；
  - 本机其他进程/账号 `curl 127.0.0.1:4575` 也确实无需凭据。
- **降级理由（三条，逐条有据）**:
  1. **设计意图显式声明的非目标**：`docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md:9`「单用户、本地运行（绑定 127.0.0.1），无需鉴权」、:121「非目标：鉴权/多用户/远程访问」，`2026-06-01-autoregister-design.md:38` 同。原报告自己也引用了这条，却仍按对外服务定级。
  2. **现代 Chrome 的 LNA 权限门控**：从 Chrome 138 可 opt-in、按官方博客「launching in Chrome 142」默认开启，公网 → 本地/回环的 `fetch()`、子资源、子框架导航请求会被 Local Network Access 权限提示拦下，且该权限**只能由安全上下文申请**（攻击者的 `http://` 页面连申请资格都没有）。这正是本条的攻击面。参见 [Chrome for Developers 公告](https://developer.chrome.com/blog/local-network-access)。
  3. **混合内容约束攻击者只能用 `http://` 页面**：官方文档写明「公网域名即使解析到本地地址也不获得混合内容豁免」，所以 https 页面 fetch `http://evil.example:4575` 会被拦，攻击者必须让用户访问一个明文 http 页面。
  残余风险仍然真实（Firefox/Safari/旧版 Chrome 无 LNA；同机其他账号；一旦 LNA 未生效则可静默读写含 SMTP 凭据的全部状态）→ **medium**，而不是 high，更不是可忽略。
- **建议（原报告的方案可用，建议加强）**: `onRequest` 钩子校验 `Host` ∈ `127.0.0.1|localhost|[::1]`（含端口），存在 `Origin` 时必须与 Host 同源否则 403；更强做法是启动时生成一次性 token 注入 `index.html`，前端所有请求带该头（对 DNS rebinding 与同机其他进程都有效）。

### [high → medium] SMTP 密码明文落盘，并以明文经 `GET/PUT /api/settings` 原样往返

- **位置**: `packages/server/src/store/store.ts:84-88, 172-176`、`packages/server/src/api/server.ts:128`、`packages/shared/src/store-types.ts:61-68`
- **成立的部分（已实测）**:
  - `GET /api/settings` 原样回传 `email.pass`（实测响应体含 `"pass":"SECRET-APP-PASSWORD"`）；
  - `writeFileSync(tmp, JSON.stringify(this.data, null, 2))`（:86）**未传 `mode`** → Node 默认 `0o666 & ~umask`，Linux/macOS 常见 `0644`（`mkdirSync(d,{recursive:true})` 同理会是 `0755`）；
  - `store.json` 里凭据就是这个明文 JSON（实测落盘内容含 `"pass"`）；
  - 前端 `web/src/pages/Settings.tsx:64,146` 确实把回读到的密码填回 `type="password"` 输入框，保存时整体回传（:83）。
- **降级理由**:
  1. **明文存本地是文档化的设计**：`docs/EMAIL_SETUP.md:47-48`「Credentials are stored in the app's local data file (gitignored) — they never leave your machine」；`shared/store-types.ts:61` 也写「SMTP settings …, edited in the UI (stored locally)」；P6 计划（`docs/superpowers/plans/2026-06-02-p6-api.md:27`）专门把 SMTP 配置从 `.env` 迁进 Settings 页。所以「落盘」不是缺陷。
  2. **原报告的一处事实错误**：`data/` **已在 `.gitignore`（:31-36）里**，不会进提交；「data/ 位于 git 工作区内」不构成泄露路径。真正剩下的只有「同机其他账号可读」（Unix 默认 0644 成立，Windows 忽略 mode，靠 ACL）。
  3. **读取路径与上一条同源**：能取走 `pass` 的只有 DNS rebinding（已被 LNA 门控）或本机访问，所以它的暴露级别不可能高于上一条。
- **维持 medium 的理由**: 凭据是「读接口原样回传」这一条独立成立且不必需——UI 只需要知道「是否已配置密码」（`hasPassword` 布尔）。凭证一旦被读走可用于以用户身份发信，且 Gmail App Password 长期有效。再加 Unix 默认权限过宽（与文档「never leave your machine」在多用户机器上相悖）。
- **建议**: 读接口不回传 `pass`（改为 `hasPassword`，更新时空值表示保持原值）；`writeFileSync(tmp, data, { mode: 0o600 })` 且目录 `0o700`；有条件时改用系统钥匙串/safeStorage。

### [medium → low] `store.json` 读取/解析失败一律判为损坏，备份失败后仍继续以空数据启动，可能覆盖掉唯一一份数据

- **位置**: `packages/server/src/store/store.ts:52-82, 84-88`
- **成立的部分（已复现）**: 用一个「存在但解析失败」的 `store.json` 并把备份路径占住（Windows 上 `renameSync` 目标为目录即失败）构造出 `catch` 分支：
  ```
  --- constructing Store (backup rename is forced to fail) ---
  targets after load: []
  original file content preserved? false
  store.json now starts with: { "targets": [], "events": [ …
  [store] Corrupt store.json — backed up to …\store.json.corrupt. Starting fresh.
  ```
  即：备份失败 → 以默认空数据启动 → 用户下一次任何写操作就把空状态写回原路径（`writeFileSync(tmp…) + renameSync`，:86-87 无条件覆盖），原始内容不复存在。原报告所述「备份失败后仍继续写」与「`.corrupt` 为固定文件名，二次损坏互相覆盖」两点都成立。
- **降级理由**:
  1. **fallback 是显式注释过的设计决定**：:67-69「best-effort backup; if rename fails we still start fresh」，:63「corrupt file — back it up before starting fresh」。这不是遗漏的守卫，而是有意取舍；把它当 medium 缺陷会与代码自述的意图冲突。
  2. **触发条件窄且有外部性**：「读取失败但并非损坏」需要外部进程对 `store.json` 持独占句柄（OneDrive/杀软/编辑器）——应用自身从不长期持有该文件（写-临时-改名，句柄瞬时），窗口很小。
  3. 复现中同时发现一处**日志不实**（可顺手修）：备份实际失败时仍打印 `backed up to …`。这条不单列，归入本条的修复建议。
- **建议**: `load()` 区分 `ENOENT` 与读取/解析失败；备份失败时进入只读降级并显式报错、拒绝继续写；备份名带时间戳；日志按实际结果措辞。

---

## Refuted（不成立）

无。8 条发现的技术事实与行号经逐条复核全部对得上（仅 `scheduler.ts:315` 一处行号应为 314-316），未发现凭空想象的调用顺序、不存在的前置守卫或读错的语义。

---

## New（原报告遗漏，本次新发现）

无 critical/high 新增。以下是我为「找漏」而实际验证过、结论为**不构成新缺陷**的方向，一并记录以免重复劳动：

1. `runtime.ts:35` 的 `void notifier.notify(e)` 是同类 fire-and-forget，但 `Notifier.notify` 内部对桌面通知与邮件分别 try/catch（`notifier.ts:19-33`），`shouldNotify`/`buildNotification` 是纯函数、`getSettings()` 不抛，**无法产生未处理 rejection**——不能作为第二条崩溃入口。
2. 静态托管与 SPA fallback 的穿越：对真实 `buildServer`（`AUTOREG_WEB_DIST` 指向临时 dist，旁边放 `SECRET-*.txt`）实测 13 种载荷（`/../`、`..%2f`、`%2e%2e%5c`、`..%252f`、`....//`、`%c0%ae`、多级），**无一泄露**（`..%5c` 系列 403、超长编码 400、其余落回 index.html）。原报告「静态目录不可穿越」成立。
3. 原型污染/未知字段：`targetPatchSchema` 是 `.strict()`，zod 只按 shape 构造输出对象（`__proto__` 既不会被当作键也不会通过 `.strict()`），`addTarget` 的 `{...input}` 只可能拿到 schema 内字段——无可利用路径。
4. 前端无 `dangerouslySetInnerHTML`/`innerHTML`（grep 零命中），事件文本经 React 转义；`event.message` 也承载不了主动注入（写入端是固定的模板串）。无存储型 XSS。

---

## 复现要点（已验证，供维护者）

1. **进程崩溃（critical）**: `npm run serve` → 登录成功 → 添加课程并「全部启动」（有到期目标）→ 关闭 Playwright 的 Chromium 窗口 → ≤30 秒进程退出码 1；控制台/API/WS 同时消失。最小复现（不依赖 Minerva）：用真实 `Scheduler` 把 `session.isLoggedIn` 换成抛 `SessionManager not launched — call launch() first` 的假守卫，`start(20)`，进程同样以 exit code 1 结束。
2. **CSRF 盲写**: 任意 http 页面提交 `<form method=POST enctype="text/plain" action="http://127.0.0.1:4575/api/scheduler/stop-all">` → 全部课程变 `paused`、引擎停止、`store.json` 立即更新（读接口仍受 CORS 保护，等于盲写）；把 action 换成 `start-all` 且当前无会话，可在 30 秒内远程打掉整个服务。
3. **WS 跨站订阅**: 在浏览器控制台（任意 http 页面）`new WebSocket('ws://127.0.0.1:4575/api/stream')` → 立即收到最近 200 条事件快照与后续增量（服务端接受任意 `Origin`，实测 `http://evil.example.com` 亦然）。
4. **`limit=0`**: 先让应用产生若干事件，再 `curl 'http://127.0.0.1:4575/api/events?limit=0'` → 返回整份日志（照注释应为 `[]`）；`limit=`、`limit=-5` 同。
5. **空白字段**: `curl -X POST http://127.0.0.1:4575/api/targets -H 'content-type: application/json' -d '{"term":" ","subject":"COMP","faculty":"Faculty of Science","courseNumber":"551","targetCrn":"1814","mode":"auto"}'` → 500 并回显 `addTarget: missing required field "term"`（应为 400）。
