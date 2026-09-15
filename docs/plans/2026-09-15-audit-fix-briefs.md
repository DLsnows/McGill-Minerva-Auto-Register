# 审计 P0 + P1 修复施工手册

> 所有者已批准修复审计清单的 **P0（4 条）+ P1（9 条）**，并批准把 `@fastify/static` 升级到 10.x。
> 完整清单与原证据在 `docs/plans/2026-09-15-audit-inventory.md`（各条目给了 `file:line` 与实测证据）。
>
> 集成分支：`feat/audit-p0-p1`（基座 `23ad6c0`）。子支线 PR 的 base 是它。
> 通用纪律见根 `AGENTS.md`：不要 push 长期分支、不要合并自己的 PR、不要动 `.github/workflows/claude-code-review.yml` 与 `pr-agent.yml`。

---

## 通用要求（所有工作流）

1. **先读清单里对应条目**（`docs/plans/2026-09-15-audit-inventory.md`），那里有触发路径、后果、实测证据。本手册只给执行要点。
2. **必须补回归测试**，而且**要证明它在修复前会失败**。这是本次批次反复出现的教训：多轮评审都抓到「断言太弱导致缺陷静默通过」。请在 PR 描述里写明你如何验证「修前红、修后绿」。
3. 本地门禁全绿才提交：`npm run lint` / `npm run typecheck` / `npm test` / `npm run build:web`；建议再跑 `BASE_REF=origin/feat/audit-p0-p1 npm run format:check:changed`。
4. 改动后跑 `npm run e2e`（首次需 `npm run e2e:install`）——涉及前端或 API 契约时必须跑。
5. i18n 三语同步（`packages/web/src/i18n/index.ts` 的 zh/en/fr，`en` 是类型基准）。只动自己命名空间下的键。
6. **不要改 `package-lock.json`**，除非任务明确要求（只有 `api-hardening` 需要）。
7. 开 PR 到 `feat/audit-p0-p1`，然后在 PR 上**逐条回复**评审评论（已修 / 误报 / 不改+理由）。
8. 如果 W1 的公共设施（进程级兜底、会话互斥、时钟注入）与你的改动相交，**以 W1 的实现为准**，不要各自造一套。

---

## W1 — `feat/audit-resilience`（Q1 / Q3 / Q9 / Q11）

**核心主题：进程不能死、停止要真的停、状态不能无声改变。** 这是本批次最关键的工作流，因为它同时修掉「服务莫名退出」的根因。

### Q1（critical）tick 定时器内的异常会终止整个服务进程
- 位置：`packages/server/src/scheduler/scheduler.ts:314`（`void this.tick().finally(...)` 无 `.catch()`）、`:105`（`isLoggedIn()` 是全段唯一无保护的 await）、`:335-337`（`tick()` 的 for 循环无 per-target 保护）
- 要求：
  - 定时器回调改为 `.catch()` 记录 error 事件（走 `this.log('error', ...)`），绝不冒泡；
  - `tick()` 内**每个目标单独 try/catch**，一个目标抛错不能饿死本轮其余到期目标；
  - `isLoggedIn()` 抛错按「会话不可用」处理（等同返回 false 的暂停路径），不要让它冒泡；
  - `packages/server/src/api/main.ts` 注册进程级 `unhandledRejection` / `uncaughtException` 兜底：记录 error 事件 + 不要静默退出（是否退出由你判断，但必须在 PR 里说明理由）；
  - `store` 的写路径（`writeFileSync`，磁盘满/被占用）也走同一条兜底。
- 测试：注入一个必然抛错的 watcher / session，断言进程不崩、其余目标仍被轮询、日志里有 error 事件。**并证明修前会因未捕获 rejection 而失败。**

### Q3（critical）error 终态没有恢复入口
- 位置：`scheduler.ts:199-210`（置 error）、`api/server.ts` 的 start-all、`packages/web/src/components/CourseCard.tsx`（PAUSABLE/RESUMABLE 都不含 error）
- 注意：`feat/start-polling`（PR #34）**已经**加了 `POST /api/targets/:id/resume` + 卡片「⟳ Resume watching」+ `start-all` 可恢复 error。**先 rebase 到最新集成分支确认这些已在**（集成分支已含相关改动？如未含则本工作流要补）。
- 还要补的（清单 Q3/Q20 明确列出、PR #34 未覆盖的部分）：
  - `start-all` 的响应里区分「恢复了 N 门 / 跳过 M 门终态课程」，并让**前端可见**（不能只返回不展示）；
  - Courses 编辑表单保存查询字段后，若目标处于 `error`，**复位为 watching 并 `scheduleNext`**（清单 Q3 的修复方向之一）。

### Q9（high）`stop-all` / Pause 无法中断在飞周期：停止后仍会提交注册
- 位置：`scheduler.ts:93-96`（只在入口读一次状态）、`:183`（`act()` 前无复检）、`:320-323`（`stop()` 只 clearInterval）
- 要求：`act()` **之前**重新读取 `store.getTarget(targetId)?.status === 'watching'`，不满足则中止本轮（记 info 事件说明原因）；引入 `stopRequested` / generation 令牌，`stop()` 时递增，周期内定期检查。测试：让 `checkCourse` 在周期中途暂停，期间把目标改 paused / 调 `stop()`，断言**没有**发生注册提交。
- 与 Q14 同源（`stop()` 不取消在飞周期），一并处理。

### Q11（medium）启动时把 watching 静默改成 paused，不写事件
- 位置：`packages/server/src/api/main.ts:12`、`store.ts:134-144`
- 要求：保留「启动不自动轮询」的既有设计意图，但 `pauseAllWatching()` 之后由 `main.ts` **记一条 warn 事件**（例如「启动时把 N 门课程重置为暂停」），让前端控制台能看到原因。**不要**改成自动恢复轮询。

---

## W2 — `feat/audit-automation-safety`（Q2 / Q4 / Q22）

**核心主题：浏览器自动化不能串页、不能把成功读成失败。** 本工作流动 `packages/server/src/minerva/**` 与 `session-manager`，**不要**动 scheduler 的状态机（那是 W1）。

### Q2（critical）所有目标共用一个 Playwright page，无会话级互斥
- 位置：`session-manager.ts` 的 `getPage()`（所有调用者拿到同一个 Page）、`scheduler.ts:60-62`（`inFlight` 只按 targetId）、`register-client.ts:46-51`（Quick Add/Drop 提交整张 worksheet）
- 后果：手动「⚡ Register now」与后台周期并发时互相串页，**最坏会提交非预期的 CRN**。
- 要求：把互斥粒度从「单个 target」提升到「整个浏览器会话」——在 `SessionManager` 上加全局串行队列/异步锁，**所有浏览器操作（查询、注册、登录、`isLoggedIn` 探测）一律排队**。手动强制运行改为排队而非并行。
- 测试：构造两条并发周期，断言它们**不交错**（例如记录操作序列，断言一个周期的导航序列不被打断）；断言「排队而非丢弃」（第二个请求最终会执行）。

### Q4（critical）注册提交后不等结果页就解析
- 位置：`packages/server/src/minerva/register-client.ts:48-52, 67-72`
- 审计员已用真实 Chromium 复现：`waitForLoadState('domcontentloaded')` 只花 1–3ms 返回（空操作），`page.content()` 拿到 58 字符的半截 HTML → 解析成 `not-found` → 真实注册成功却被当成无事发生 → 下一轮再次提交 → 3 次后变 error。
- 要求：
  - 提交后**等待结果页锚点**：`page.waitForSelector('table[summary="Current Schedule"], table[summary*="Registration Errors"]')`（或 `waitForURL` / 等导航完成），**再**解析；
  - `content()` 失败或解析失败**不要退化成 not-found**（要有独立的「解析失败」结果）；
  - **对 not-found 不触发再次提交的循环**。
- 测试：新增一条用假 Page（或 mock content 延迟返回）的测试，断言修前得到 not-found、修后等待并正确解析。参照 `query-client.ts:67`（查询路径**有** 8s `waitForSelector` 兜底，注册路径没有）。

### Q22（medium）解析失败与「CRN 未找到」不可区分
- 位置：`packages/server/src/minerva/parse-sections.ts:15-16, 41-42`、`query-client.ts:65-68`、`scheduler.ts:130-137`
- 问题：`parseSections` 在「没有结果表」与「表头 7 列没认全」两种情况下**都返回 `[]`**，于是被当成「CRN 不存在」并累计失败连击，3 次后把目标置为 error——**归因错误**。
- 要求：让解析层区分「页面无结果」与「页面结构不认识」（返回标志位或抛类型化 `ParseError`）；后者记**明确的** error 事件且**不计入「CRN 不存在」的失败连击**；必要时保留上轮 `lastStats`。

---

## W3 — `feat/audit-api-hardening`（Q5 / Q6 + `@fastify/static` 10.x）

**核心主题：本地 API 的来源校验 + 依赖升级。** 本工作流**唯一**需要改 `package.json` / `package-lock.json`。

### Q5（high）本地 API 无 Host/Origin/CSRF 防护
- 位置：`packages/server/src/api/server.ts`（5 个不读 body 的 POST 端点）、`main.ts:15`（绑 127.0.0.1）
- 审计员实测：`<form method=POST enctype=text/plain action=http://127.0.0.1:4575/api/scheduler/stop-all>` → **200**，全部课程被 pause、引擎停止、store.json 立即更新。无 body 的 POST 与 `text/plain` 都是 CORS 简单请求，**不触发预检**。
- 与 Q1 联动 = **远程杀进程**：跨站 `POST /api/scheduler/start-all` 在窗口已关时 30 秒内触发未处理 rejection。
- 要求（在 `onRequest` 统一做）：
  - 校验 `Host` ∈ `127.0.0.1` / `localhost` / `[::1]`（带端口的也要正确解析）；
  - **存在 `Origin` 时必须与 Host 同源**，否则 403；
  - 所有写接口要求 `Content-Type: application/json`（无 body 的 POST 也要带，或改为检查 `Origin` 即可 —— 你判断哪种更稳妥，但要说明）；
  - 补 `X-Frame-Options: DENY` 与 CSP `frame-ancestors 'none'`。
- 测试：模拟敌意 `Origin` / 伪造 `Host` / `text/plain` 表单提交，断言被拒；**并断言正常的同源请求仍工作**（不要为了安全把应用打死）。参照 `claude-code-review` 那次的「fork 守卫」写法：默认拒绝、显式放行。

### Q6（high）WebSocket `/api/stream` 不校验 Origin
- 位置：`packages/server/src/api/server.ts` 的 `/api/stream` 注册
- 审计员实测：`Origin=http://evil.example.com` → **握手成功并收到最近 200 条事件快照**。
- 要求：升级握手时校验 `Origin`（只允许应用自身来源）；给 `maxPayload` 设有限值（当前 `@fastify/websocket` 默认 0 = 不限）。
- 测试：用真实 `ws` 客户端带敌意 `Origin` 握手，断言被拒；同源断言成功。

### `@fastify/static` 9.x → 10.x
- 现状：lockfile 钉 `9.3.0`，而 **9.x 已 EOL——9.3.0 就是最新版且在受影响范围内**，永远不会修。通告：`GHSA-83w8-p2f5-377r`（high，path traversal）与 `GHSA-8pvw-jcv7-9cmj`（moderate）。
- 要求：升到 `^10.1.3`（`packages/server/package.json`），重新生成 lockfile（用 `npm install`，**不要**用 `npm ci`），确认 `content-disposition` 从 1.x 跳到 2.x 后响应头行为正常。
- **必须实测**：起服务，确认 `/`、`/courses`、`/settings` 正常加载（含 SPA 回退 `setNotFoundHandler` → `index.html` 那条路径，见 `server.ts:259-271`），`npm run e2e` 4/4 通过。
- 说明：我们的用法只有 `app.register(fastifyStatic, { root: webDist })` 一处，**没有路由守卫**，所以「route guard bypass」的通告前提在本仓库不成立；但升级仍是正确做法（EOL + 真实 path traversal）。
- 注意：本机 npm 已升到 11.19.1（11.5.1 有 arborist bug 会让 `npm install` 崩）。

---

## W4 — `feat/audit-session-truth`（Q7 / Q12）

**核心主题：UI 不能谎报会话状态。**

### Q7（high）会话状态只在挂载时拉一次，永不重新校验
- 位置：`packages/web/src/lib/DataContext.tsx:19`（`useResource(() => api.getSession())` 只跑一次）、`packages/web/src/pages/Session.tsx:41-55`
- 后果：Ticker 持续绿灯 Active、Session 页持续「Authenticated — automation can run」，而服务端其实已把目标 paused。**这是唯一「核心功能静默失效 + UI 主动误导」的路径。**
- 要求：
  - 给 session 资源加**事件驱动刷新**（收到 warn/error 级事件时 `session.refetch()`）——`Dashboard.tsx` 已有 `lastEventId` 的 effect 模式可复用；
  - **不要**按原报告的 60–120s 轮询 `GET /api/session`：那个端点会真实 `page.goto(PROTECTED_PROBE_URL)`，违反本项目的 pacing 设计（会真的打学校的服务器）。清单里已给这个警告，务必遵守。
  - 参考：`GET /api/session` 内部已有 lazy 复检能力（`server.ts`），是客户端从不用它。
- 测试：模拟流事件到达后 session 被重新拉取；断言 UI 状态跟随服务端。

### Q12（high）会话状态与真实浏览器上下文解耦：UI 显示已登录、引擎却从未启动
- 位置：`packages/server/src/api/main.ts`（从不 `scheduler.start()`）、`server.ts` 的 `/api/scheduler/start|start-all`（不检查是否 `launch()` 过）
- 注意：主开关语义（Q8）已由 PR #34 修复。**本工作流要补的是**：`/api/scheduler/start*` 增加「会话/浏览器上下文不可用」的**显式拒绝或友好提示**，而不是让用户点了之后 30 秒内触发 Q1 的崩溃。
- 要求：路由检查 `session` 是否可 launch/已 launch，不可用时返回明确错误码与信息；前端把它展示出来（不要静默）。

---

## W5 — `feat/audit-resource-errors`（Q13）

**核心主题：资源加载失败不能被吞成空态。**

### Q13（high）资源加载错误被吞成空态 / 永久「加载中」/ 默认预算
- 位置：`packages/web/src/lib/useResource.ts:34-53`（只 `setError`，不 rethrow 不重试；挂载 effect 不会重跑）、`pages/Settings.tsx:61-68`（`if (!form)` 停在「加载设置中…」）、`App.tsx`、`pages/Dashboard.tsx`、`pages/Courses.tsx`
- 现状：全 `packages/web/src` **无一处读 `resource.error`**（grep 只命中测试与样式键）。所以单次瞬时失败会变成**长期状态错乱**：顶部进度用硬编码默认值与真实 remaining 混算（可显示离谱负数）；设置页在本次会话内无法打开且无重试入口；失败被渲染成「还没有监控任何课程」，用户可能以为配置被清空而**重加课程产生重复 target**。
- 要求：
  - 消费者侧统一补**错误条 + 重试按钮**（设计文档 §6 明确要求行内错误条，实现未做）；
  - **空态渲染前先判 `loading` / `error`**（不要用空态冒充失败）；
  - ticker 在 settings/budget 出错时显示**占位符**而不是默认预算；
  - `Settings.tsx` 的「已保存」以 PUT 成功为准，随后的 refetch 失败单独提示（注意：**P2 已修过这条**，集成分支上已有 `savedButRefreshFailed`，不要重复造）。
- 测试：让 `getSettings` / `getTargets` / `getBudget` 失败，断言页面显示错误条 + 重试可用（而不是空态或永久加载）；点重试后恢复。

---

## W6 — `feat/audit-expressiveness`（Q16 / Q23 / Q60）

**核心主题：API 契约的表达力——「接受了」和「丢弃了」要能区分。**

### Q16 + Q60（medium）in-flight 命中时静默丢弃，`/run` 仍返回 `started:true`
- 位置：`scheduler.ts:80-91`（`inFlight` 命中直接 return）、`api/server.ts` 的 `/run` 路由、`packages/web/src/pages/Dashboard.tsx`
- 注意：**不要去掉 in-flight 守卫**（它是防重复注册的、有意的设计——保留，只改表达力）。
- 要求：`/run` 返回可区分的结果，例如 `{ started: false, reason: 'in progress' }`，或**排队执行一次**（与 W2 的会话队列配合——**先与 W2 对齐**，不要各自实现队列）。前端据此提示「正在执行中」而不是让按钮闪一下什么都没发生。

### Q23（medium）手动「Register now」缺少节流/冷却
- 位置：`packages/web/src/pages/Dashboard.tsx`、`api/server.ts` 的 `/run`、`scheduler.ts`
- 问题：手动执行**不经过 `nextPollAt` 节流**（`tick()` 只跑到期的 target，而 `/run` 直接调 `runTarget`），所以串行连点会逐次真实查询 Minerva，唯一硬约束是每日预算。这与本项目反复强调的 pacing 意图冲突。
- 要求：服务端记录 `lastForcedRunAt`，冷却期内返回 `{ started: false, reason: 'cooldown' }`（冷却时长你定，但要写进文档与 UI 文案）；前端给出可见反馈。

---

## 完成标准（每个工作流）

- 对应条目全部落地，且**有能证明「修前会失败」的回归测试**。
- 门禁全绿 +（涉及前端/契约时）`npm run e2e` 4/4。
- PR 开向 `feat/audit-p0-p1`，描述含：根因、修法、测试证据、风险与回滚、reviewer 重点。
- 评审评论逐条回复。
- **不合并 PR。**
