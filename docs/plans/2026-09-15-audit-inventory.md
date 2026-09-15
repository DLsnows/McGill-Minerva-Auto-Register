# MMAR 代码审计问题清单

> 由 6 份代码审计报告（审计线 A 调度器与运行时并发 / B 会话与 Minerva 自动化 / C 设置与预算展示一致性 / D 启动与状态转换流程 / E API 契约与安全性 / F 前端健壮性与测试缺口）合并去重、统一排序后形成，供项目所有者审批。
> 所有条目均已由技术主管只读打开 `C:/Users/lenovo/deepseekHarness/Auto-Register/wt/audit` 下的源码逐条核对（引用行号与代码语义一致），并补充了修复批次、用户可见性与状态判断。

## ⏳ 审批状态：**等待项目所有者批准**（尚未修复任何一条）

按项目所有者指示「扫出来的现有 bug 先不修，扫出来给我看，我了解并且批准了再修」，本清单**只做记录**，未对任何条目动手。

### P0 四条已由调度者**二次独立复核**（2026-09-15）

这 4 条在最关键路径上，调度者用下述命令亲手确认，不是只转述审计员的结论：

| 条目 | 复核命令 | 复核结果 |
|---|---|---|
| **Q1** tick 无 `.catch()` | `Select-String -Path packages/server/src/scheduler/scheduler.ts -Pattern 'void this\.tick\|\.finally\('` | 只命中 `314: void this.tick().finally(` —— **无 `.catch()`**，全仓无 `unhandledRejection` 处理器 |
| **Q2** 共用单一 Playwright page | 阅读 `session-manager.ts` 的 `getPage()` | `ctx.pages().find(p => !p.isClosed())` 返回**同一个 Page** 给所有调用者；全仓 `mutex\|lock\|queue\|semaphore` **零命中**（唯一匹配是注释文本） |
| **Q3** `error` 是死状态 | `Select-String -Path packages/server/src/api/server.ts -Pattern 'paused'` + `CourseCard.tsx` 的 `PAUSABLE\|RESUMABLE` | `server.ts:199` 只捞 `filter(t => t.status === 'paused')`；`CourseCard.tsx:22-23` 的 `PAUSABLE=['watching']` / `RESUMABLE=['paused']` **都不含 `error`** |
| **Q4** 注册后不等待结果页 | `Select-String -Path packages/server/src/minerva/register-client.ts -Pattern 'waitForSelector\|waitForLoadState\|page.content'` | `register-client.ts:52` 直接 `page.content()`；**对照** `query-client.ts:67` 有 `waitForSelector('table.datadisplaytable', { timeout: 8000 })` —— 注册路径**没有**对应等待 |

### 与本次已实现修复的对应关系（供批准时对比）

- **Q10**（ticker 显示错乱）= 报障 1 的根因 → 已由 `feat/budget-progress` 修复
- **Q8 + Q12**（主开关绑错对象 / 引擎从不自启）= 报障 2 的根因 → 已由 `feat/start-polling` 修复
- **Q13**（资源加载错误被吞成空态）与 Q10 同源，`feat/budget-progress` 部分覆盖（ticker 占位符）；错误条与重试入口仍未做
- **Q20**（`error` 恢复语义）与 Q3 同源，`feat/start-polling` 已补「重新监控」入口，但 Q3 的**全部**侧面（`start-all` 的跳过计数、编辑保存时复位 status）尚未全部覆盖

### 建议（调度者意见，最终由所有者决定）

建议至少把 **P0 四条（Q1–Q4）** 与 **P1 九条（Q5–Q13）** 纳入本批次。理由：

- Q1–Q4 覆盖「进程会死 / 可能注册错课 / 注册成功不认 / 课程永久停摆」四类不可接受后果，且都落在本次正在改的同一批文件上，改动面小；
- Q5/Q6（本地 API 无 Host/Origin 校验、WebSocket 不校验 Origin）是安全边界问题，已被审计员用真实 fastify + 真实 TCP 握手实测复现；
- Q7（会话状态永不刷新，UI 主动谎报 Active）是唯一「核心功能静默失效 + UI 误导」的路径。

P2/P3 共 47 条建议单独排期，不要塞进本次。

## 概览

- **总数 60 条**：原始 6 份报告共 53 条发现，合并 9 组同根因重复项后为 44 条，另有 16 条由技术主管在核对源码后补出（含 12 条此前未被任何审计线单列的实现缺口，以及 4 条由既有条目的附带观察析出）→ 44 + 16 = 60。严重度分布：critical 11 / high 12 / medium 18 / low 19。
- **修复批次**：P0 = 4 条（阻断性，必须本次修）；P1 = 9 条（本次应该修）；P2 = 21 条（可排队）；P3 = 26 条（记录待办，暂不修）。
- **按严重度 × 批次**：P0 = 4 critical；P1 = 1 critical + 7 high + 1 medium；P2 = 5 critical + 4 high + 3 medium + 9 low；P3 = 1 critical + 1 high + 13 medium + 11 low。
- **必须先修（P0）**：Q1 未处理 rejection 崩溃整个服务进程（一次关窗/断网即触发）→ Q2 会话级并发无互斥导致串页甚至提交错 CRN → Q3 `error` 死状态让监控永久停摆且 UI 无恢复入口 → Q4 注册提交后不等结果页就解析，成功注册被读成失败并诱导重复提交。这四条合起来正好覆盖「进程会死、可能注册错课、注册成功也不认、课程会永久停摆」四类不可接受后果，建议作为本次修复的独立 PR 先行合入。
- **合并说明（同根因去重，只计一次）**：
  1. 未处理 rejection 杀进程：A-A1 + B-A1 + D-A2 + E-A1 → **Q1**。
  2. 共享 Playwright page 无全局互斥：A-A3 + B-A3 → **Q2**（并入「登录流程也驱动同一 page」）。
  3. `error` 终态无恢复通道：A-A2 + D-A7 → **Q3**（其 UI/接口侧面另立 Q20，计数侧面另立 Q27）。
  4. 注册提交后不等结果页：B-A2（成功判定）+ B-A2 的流程依据 → **Q4**（实现依据另立 Q21，作为同一修复的锚点待办）。
  5. 停止/暂停不取消在飞周期：A-A5 + D-A9 → **Q9**（`stop()` 的实现缺口另立 Q14）。
  6. in-flight 丢弃无反馈：B-A4 + D-A6 → **Q16**（契约表达力另立 Q60）。
  7. store 读/解析失败一律判损坏 + 备份失败吞掉：A-A6 + E-A8 → **Q32**（`.corrupt` 固定名与日志不实另立 Q58；fsync 缺失另立 Q33）。
  8. 预算拉伸/午夜边界/改预算不重排：A-A7 + C-C5 → **Q24**；另与 D-D3 的 pause→watching 不重排合并为 **Q37**（同一 `rescheduleWatching` 缺失）。
  9. 数字输入 `Number(e.target.value)` 与越界 400：C-C4 + F-F4 → **Q34**（schema 卫生与间隔展示失真另立 Q39）。
- **跨线重复提示**：Q11（启动归一化静默无事件）与 Q8/Q12（加课后不自动启动引擎）同根因但改动点不同，若想压缩条目可合并为一条；Q14 与 Q9、Q42 与 Q38、Q20 与 Q3 亦为同一缺陷的不同侧面，本轮为便于分派修复而分列。
- **与已知报障的对应**：Q10（ticker 伪造进度）是「报障 1」的直接根因；Q8/Q12（首次点击执行 stop-all、必须重启才正常）是「报障 2」的直接原因；Q1、Q3、Q9、Q11、Q32 也被列为报障中的可疑症状。其余为本次审计新增项。

排序规则：critical → high → medium → low；同严重度内按修复紧迫度（用户会撞到 > 潜在风险）。Q 编号即最终排序。

---

## P0 — 阻断性

### Q1 [critical] tick 定时器内的异常无人接管，unhandledRejection 直接终止整个服务进程

- **位置**: `packages/server/src/scheduler/scheduler.ts:105-109,314-316,335-337,80-91`；`packages/server/src/session/session-manager.ts:29-31,34-37,56-60`；`packages/server/src/api/main.ts:12,19-22`
- **来源**: 审计线 A（A1）、B（A1）、D（A2）、E（A1）——四线独立确认，合并且只计一次
- **触发**: 任一目标处于 watching 且 `nextPollAt` 到期。`runCycle` 中唯一没有 try/catch 的 await 是 `scheduler.ts:105` 的 `isLoggedIn()`（`checkCourse` :120-127 与 `act` :182-189 都有保护）。真实抛错源：用户关掉那个 headful Chromium 窗口 → `context.on('close')` 把 `this.context` 置 null（session-manager.ts:29-31）→ 下次 `getPage()` 经 `requireContext()` 抛 `SessionManager not launched — call launch() first`（:34-37），或页面崩溃抛 Target-closed，或断网/Minerva 维护时 `page.goto(PROTECTED_PROBE_URL)` 未传 timeout、默认 30s 超时 reject（:56-60）。异常沿 `runCycle` → `runOnce`（仅 try/finally，:86-90）→ `tick()` 的 `await this.runOnce`（:336）→ `void this.tick().finally(...)`（:314-316，finally 不消费异常，派生 promise 无人接管）冒泡。
- **后果**: Node ≥ 22（根 `package.json` engines、`.nvmrc`=22）对未处理 rejection 默认 throw，仓库内 `unhandledRejection|uncaughtException|process.on(` 零命中、`main.ts` 只有启动阶段的 `main().catch()` → 整个 Node 进程 exit 1：REST API、WS 推送、轮询同时消失，前端 WS 以 ≤30s 退避永久重连（界面停在「重连中…」）；重启后 `pauseAllWatching()` 又把残留 watching 改回 paused，监控在用户不知情下彻底停止。`tick()` 的 for 循环本身也无 per-target try/catch，补上全局兜底后「一个目标抛错饿死本轮其余到期目标」才会暴露。另：`store.updateTarget/appendEvent`（→ store.ts:84-88 的 `writeFileSync`）同样无保护，磁盘满/杀软占用会走同一崩溃路径。
- **用户可见**: 会（控制台整页失联、日志停在半小时前、重启后课程全变 paused）
- **状态**: 已知报障根因（多条报障中「服务莫名停掉/断线重连」的机制解释）
- **修复方向**: 定时器回调改为 `.catch()` 记 error 事件，`tick()` 内对每个目标单独 try/catch，把 `isLoggedIn()` 异常按「会话不可用」处理（等同返回 false 的暂停路径），并在 `main.ts` 注册进程级 `unhandledRejection` 兜底日志。
- **证据**: `scheduler.ts:314` `void this.tick().finally(() => { this.ticking = false; })` 无 `.catch()`；:105 是 :105-193 全段唯一未受保护的 await；对照 `runTarget()`（:219-223）有 `.catch()`，证明是遗漏而非设计。等价结构（setInterval + `void tick().finally(...)` + 必然 reject 的 await）在两份独立报告的本机 Node v24.5.0 探针下均 exit code 1 终止。B 线修正点：关窗后 `loadCycle` 可能已先拿到 Page，实际抛错更可能是 Target-closed 而非 `SessionManager not launched`；`goto` 是默认 30s 超时而非永久挂起。

### Q2 [critical] 所有目标共用同一个 Playwright page 且无会话级互斥，手动强制运行会与后台周期互相串页（最坏提交错 CRN）

- **位置**: `packages/server/src/scheduler/scheduler.ts:60-62,80-91,219-223,330-338`；`packages/server/src/session/session-manager.ts:39-44,73-108`；`packages/server/src/minerva/query-client.ts:21`；`packages/server/src/minerva/register-client.ts:16,39,46-51`；`packages/server/src/api/server.ts:115-125,162-184`；`packages/web/src/pages/Dashboard.tsx:87-98`
- **来源**: 审计线 A（A3）、B（A3）——同一根因，合并
- **触发**: `tick()` 是串行的，并发只可能来自手动/强制运行：用户在目标 B 的卡上点「⚡ Register now」→ `POST /api/targets/:id/run`（server.ts:115-125，只要求 B 是 watching）→ `scheduler.runTarget(id)`（:219-223，fire-and-forget）→ `runOnce(B,{force:true})`。`inFlight` 键是 targetId（:85-89），B 未被占用即放行；此时若调度器正为目标 A 跑周期（`checkCourse` 内 9 次 `humanPause()` + 多次导航，单周期约 30-60s），两条周期经 `session.getPage()` 拿到同一个 Page（`ctx.pages().find(p => !p.isClosed())`，:42）并各自 `goto/selectOption/fill/click/content()`。先后点两张卡的两条手动运行同样并发。登录流程（`POST /api/session/login` → `ensureLoggedIn()`，server.ts:162-184 → session-manager.ts:73-108）也驱动同一 Page。
- **后果**: 交错的导航/取内容会让一方读到另一方的页面（`parseSections` 得到别的课程 → CRN 不在结果中 → 记一次失败，3 次后按 Q3 永久停摆），或让 `page.click('input[name="REG_BTN"][value="Submit Changes"]')` 落在被另一方重写过的表单上。补强机制：Quick Add/Drop 提交的是整张 worksheet（register-client.ts:46 往第一个空 `input[name="CRN_IN"]` 填 CRN，:48-51 点 Submit Changes），两条周期共用同一页面时另一目标的 CRN 可能正躺在同一张表里被一起提交——即「提交非预期注册」的现实路径；结果再按各自 CRN 解析，真实注册被记成 not-found。UI 侧 `runTarget` 是 fire-and-forget，按钮 running 只是本卡本地标记（Dashboard.tsx:87-98），其他卡按钮保持可点。
- **用户可见**: 会（结果归属错乱、注册错课程、课程莫名变 error；但需用户手动点击触发）
- **状态**: 已知报障根因（与「课程突然变 ERROR」「注册结果对不上」类报障同源）
- **修复方向**: 把互斥粒度从「单个 target」提升到「整个浏览器会话」——在 SessionManager 上加全局串行队列/异步锁，所有浏览器操作（查询、注册、登录、`isLoggedIn` 探测）一律排队，手动强制运行改为排队而非并行（或为每个周期分配独立 Page）。
- **证据**: `packages/server/src` 内 `mutex|lock|queue|semaphore` 零命中（唯一相关匹配是注释文本）；`inFlight` 是 `Set<string>` 且只在 `runOnce` 里按 targetId 增删（:81-90）；`getPage()` 把同一个 Page 发给所有调用者；`scheduler.test.ts:326-355` 固化的只是「同一目标不并发」。Playwright 的 page 级操作队列不是事务，跨周期交错是真实语义。

### Q3 [critical] 连续 3 次失败置为 `error` 后没有任何恢复入口，目标永久停摆且「照日志提示改数据」也救不回来

- **位置**: `packages/server/src/scheduler/scheduler.ts:41-48,93-96,199-210,120-138,250-254`；`packages/server/src/api/server.ts:198-203`；`packages/web/src/components/CourseCard.tsx:19-31,49-59,63`；`packages/web/src/pages/Courses.tsx:39-46`；`packages/web/src/pages/Dashboard.tsx:75`
- **来源**: 审计线 A（A2）、D（A7）——同一根因，合并
- **触发**: 三个入口都能累计 streak：`checkCourse` 抛错（:120-127）、目标 CRN 不在结果中（:130-138）、`actor.act()` 返回 `kind:'error'`（:250-254；`parse-register-result.ts:69-70` 把任何非 closed/class full/waitlist 的提示都归为 error，含 Time Conflict / Prerequisite / Department Consent / Level Restriction）。第 3 次连续失败时 `noteFailure` 写 `status:'error'`、删 streak，调用方随即 return 且不再 `scheduleNext`（:201-205 配合 :124/:135/:186/:252）。
- **后果**: 此后 `runCycle` 对非 watching 目标直接返回（:96），目标不再被轮询；课程卡 `PAUSABLE=['watching']`/`RESUMABLE=['paused']` 都不含 error，暂停/恢复按钮不渲染（CourseCard.tsx:22-23,49-59）；「⚡ Register now」因 `canRun = status==='watching'` 而 disabled（:29,63）；主开关 start-all 只捞 paused（server.ts:199，`server.test.ts:346-365` 断言 error 不变）；Courses 编辑表单只 PATCH 查询字段、从不改 status（Courses.tsx:39-46），全前端唯一写 status 处是 Dashboard.tsx:75（仅 watching↔paused）。于是目标进入 UI 无法离开的终态，点 Start all 得到 `{running:true, resumed:0}` 且前端不读该响应（Dashboard.tsx:115），界面零反馈；唯一出路是删除课程再重新添加，代价是丢 label 与 lastStats，且界面无任何提示。触发源包含纯瞬时条件（一次网络中断/探测抛错即可累计 3 次）。
- **用户可见**: 会（红色 ERROR 徽章 + 控制台 error 行，但「怎么恢复」完全不可发现）
- **状态**: 已知报障根因
- **修复方向**: 保留「error 不再自动重试」的语义，但补一条显式恢复通道（课程卡「重新监控」按钮，或编辑查询字段保存时把 error 复位为 watching 并 `scheduleNext`），并让 start-all 的返回/提示明确说明「N 门课程因错误被跳过」。
- **证据**: `scheduler.test.ts:233-235` 断言 “Now stopped: a further run does not query again”；设计规范本意是失败后回到 watching（`docs/superpowers/specs/2026-06-01-autoregister-design.md:94`「记录并报告 ──► watching（继续轮询）」，终态约定 :99 只列 registered/waitlisted），计划 `2026-06-02-p5a-store-scheduler.md:170` 同样写 “on error -> log error; schedule next (keep watching)”；而日志引导用户改的字段（:134）改对了也不恢复监控。卡片不给 error 复活入口是有意的（提交 8b60287、CourseCard.tsx:19-21 注释、CourseCard.test.tsx:71-80），但实现改成终止态后没有任何配套恢复通道。

### Q4 [critical] 注册提交后不等结果页加载就解析内容，成功注册被读成 not-found 或抛错，并诱导重复提交

- **位置**: `packages/server/src/minerva/register-client.ts:48-52,67-72`
- **来源**: 审计线 B（A2）
- **触发**: auto 模式命中空位自动提交，或手工执行 register --confirm。提交后结果页（bwckcoms.P_Regs）由 Banner 现场渲染；`waitForLoadState('domcontentloaded')` 与该 document 早已触发过的 DCL 属同一生命周期事件，无法为紧随其后的 `page.content()` 提供任何等待，响应体到达慢时即读到半截 HTML。
- **后果**: `parseRegisterResult(await page.content(), crn)` 读到尚未接收完的 HTML → 表中无该 CRN → not-found → `applyOutcome` 视为无事发生并 `scheduleNext`（scheduler.ts:238-244）：真实成功注册既无 registered 状态、也无成功日志与通知，下一轮再次提交同一 CRN；若 `page.content()` 撞上导航则抛 `Unable to retrieve content because the page is navigating and changing the content.`，被 scheduler.ts:184-188 记为 Registration attempt threw。重复提交会落到 Registration Errors 分支解析为 error，`noteFailure` 连错 3 次把目标置为 error 并停止监控——明明已经注册成功。
- **用户可见**: 会（注册成功了但没有 registered 状态、没有通知，随后课程变 ERROR）
- **状态**: 已知报障根因（「明明选上了却显示失败/继续重试」类报障）
- **修复方向**: 提交后等待结果页锚点（`page.waitForSelector('table[summary="Current Schedule"], table[summary*="Registration Errors"]')` 或 `waitForURL`/`waitForNavigation`）后再解析；`content()` 失败或解析失败不要退化成 not-found；对 not-found 不要触发再次提交的循环。
- **证据**: 真实 Chromium（playwright-core 1.60 + chromium-1217）逐字复刻 :48-52 序列实测：本地服务端先 commit 再延迟写响应体，delayMs=50/200/500/1500 时 `waitForLoadState` 分别仅 1/1/1/3ms 返回（证实为空操作），`content()` 只拿到 58 字符 `<html><head></head><body><h1>processing</h1></body></html>`，喂给仓库自带解析器得到 `{"kind":"not-found","crn":"1814"}`；delayMs=0 对照组拿到含 Current Schedule 表的完整文档。源码佐证：`Frame.waitForLoadState` 在 `_firedLifecycleEvents` 已含该事件时直接返回（coreBundle.js:17655-17659），`_onClearLifecycle` 仅在新 document 提交时才清空并重新触发。对比 `query-client.ts:67` 有 8s `waitForSelector` 兜底，注册路径没有。计划文档 `p4-register.md:193-197` 即写入该片段，属计划本身缺陷而非实现走样；`packages/web` 从不调用 register-client，为 auto 模式与 CLI 必经路径。

---

## P1 — 本次应修

### Q5 [high] 本地 API 无 Host/Origin/CSRF 防护：跨站表单即可盲写调度器，并与 Q1 联动构成远程杀进程原语

- **位置**: `packages/server/src/api/server.ts:82,115,162,188,198,205`；`packages/server/src/api/main.ts:15`
- **来源**: 审计线 E（A2）、E（A6）——CSRF 与 DNS rebinding 两条同源，本清单以 CSRF/来源校验为主条，DNS rebinding 残余风险并入
- **触发**: 用户开着应用访问任意 http(s) 页面，该页自动提交 `<form method=POST enctype=text/plain action=http://127.0.0.1:4575/api/scheduler/stop-all>`，或用 `navigator.sendBeacon` 打同地址。无 body 的 POST 与 `text/plain` 均属 CORS 简单请求，不触发预检，服务端 5 个写端点（:115、:162、:188、:198、:205）都不读 body；跨站顶层表单导航不在 Chrome Local Network Access 门控范围内（fetch/子资源/子框架导航才被门控），无需用户授予任何权限。存在 Origin 时也无校验（`grep onRequest|preHandler|addHook|CORS` 零命中），伪造 `Host: evil.example.com:4575` 可直接拿到 `GET /api/settings` 全部设置。
- **后果**: (1) stop-all 把所有 watching 改 paused 并 `scheduler.stop()`、start-all 把 paused 全恢复 watching 并启动引擎（状态立即落盘 store.json），攻击者可静默开关用户的选课监控；(2) 与 Q1 联动 = 远程杀进程：跨站 `POST /api/scheduler/start-all` 在「会话从未 launch」或「Chromium 窗口已关」时 ≤30 秒触发未处理 rejection，把 REST+WS+轮询一起打掉（`/api/scheduler/start|start-all` 不检查会话是否 launch 过，server.ts:188-203）；(3) `POST /api/session/login` 同样无 body，跨站请求可在用户机器上弹出 Chromium 窗口并开始登录流程（骚扰/资源占用）；(4) 无 `X-Frame-Options`/CSP `frame-ancestors`，本地 UI 可被任意站点 iframe 套用做点击劫持。DNS rebinding 路径还能读到含 SMTP 密码的 `/api/settings`（现代 Chrome 的 LNA 已门控，Firefox/Safari/旧 Chrome 及同机其他账号仍可读）。
- **用户可见**: 不会（攻击者静默改状态；用户只会看到课程莫名 paused/服务莫名退出）
- **状态**: 新增（设计文档把鉴权列为非目标，但「跨站盲写 + 远程杀进程」超出该非目标范围）
- **修复方向**: 在 `onRequest` 统一校验 Host ∈ 127.0.0.1|localhost|[::1] 且存在 Origin 时必须与 Host 同源，所有写接口要求 `Content-Type: application/json`，再补 `X-Frame-Options: DENY` 与 CSP `frame-ancestors 'none'`；彻底做法是启动时生成一次性 token 注入前端。
- **证据**: 对真实 fastify 5.8.5 + `buildServer` 实测 content-type 矩阵：无 body/无 content-type → 200 `{"running":true}`；`text/plain` → 200；`text/plain;charset=UTF-8` → 200；`application/x-www-form-urlencoded` → 415；`multipart/form-data` → 415。精确化：`POST /api/targets` 与 `PUT /api/settings` 打不到（需 JSON 对象，text/plain body 被解析成字符串 → zod 400；真 application/json 会触发预检且服务端无 CORS 头）；跨站能盲写的恰好是那 5 个不读 body 的 POST，其中 `/api/targets/:id/run` 的 id 是 UUID 不可猜、价值≈0。实测 `<form method=POST enctype=text/plain action=http://127.0.0.1:4575/api/scheduler/stop-all>` → 全部 paused、引擎停止、store.json 立即更新。降级理由（故为 high 而非 critical）：设计文档显式声明单用户本地运行、鉴权非目标（`p7-web-frontend-design.md:9,:121`、`2026-06-01-autoregister-design.md:38`），且读接口仍受 CORS 保护。

### Q6 [high] WebSocket `/api/stream` 不校验 Origin：任意页面可跨站订阅全部事件

- **位置**: `packages/server/src/api/server.ts:236,240,244`（`node_modules/@fastify/websocket/index.js:79`）
- **来源**: 审计线 E（A3）
- **触发**: 任意 http:// 页面执行 `new WebSocket('ws://127.0.0.1:4575/api/stream')` 即可握手成功，服务端随后立即推送最近 200 条事件快照（:240）并持续广播（`broadcast`，:266-276）。插件侧无任何校验：`@fastify/websocket` 11.2.0 只做 `ws.setSocket(clientStream, head, { maxPayload: 0 })`，无 `verifyClient`/origin 选项；全仓 `grep origin|Origin|verifyClient` 零命中。
- **后果**: 泄露课程/CRN/学期、每轮决策原因、注册结果与错误文本（如 scheduler.ts:134 的 CRN not found 文案），即用户选课监控行为与结果的实时流；不含 SMTP 凭据（事件里没有 settings）。Chrome 的 LNA 文档明确列出 WebSocket 连接尚未被权限门控，因此在 DNS rebinding 读取已被 LNA 拦下的现代 Chrome 上，WS 是唯一不需要任何用户授权也不弹提示的远程读取通道。另 `maxPayload` 为 0 = 不限，恶意页面可发超大帧造成资源消耗。
- **用户可见**: 不会（纯静默信息泄露）
- **状态**: 新增
- **修复方向**: 在升级握手时校验 Origin（只允许应用自身来源，用 `verifyClient` 或复用同一条 onRequest Host/Origin 钩子），并给 `maxPayload` 设一个有限值。
- **证据**: 真实 TCP + 敌意 Origin 握手实测（真实 `buildServer` 监听 127.0.0.1 真实端口 + ws 客户端）：`Origin=http://evil.example.com` → OPEN + snapshot received（含真实业务文案 'CRN 1814 COMP 551 — poll decision: N…'）；`Origin=https://attacker.test` → OPEN + snapshot；`Origin=(none)` → OPEN + snapshot。修正原报告一处：`https` 页面是否被混合内容策略拦住随浏览器/版本而异，`http://` 页面路径已实测可用。

### Q7 [high] 会话状态只在启动时拉取一次且永不重新校验，UI 可长期谎报「已登录 / Active」

- **位置**: `packages/web/src/lib/DataContext.tsx:19`；`packages/web/src/pages/Session.tsx:41-55`；对照 `packages/server/src/api/server.ts:149-161`
- **来源**: 审计线 F（F1）
- **触发**: 打开控制台登录成功并长期挂着页面；此后 Minerva 会话自然过期，或按 UI 自己的提示在别处登录（`i18n/index.ts:67` 明写 logging in elsewhere will evict the automation）。调度器检测到登出后会把该 target 置为 paused 并写 warn（scheduler.ts:105-108）。前端再无任何代码调用 `GET /api/session`，除非重走登录流程（最多轮询 6 分钟）或整页刷新。
- **后果**: Ticker 会话点持续绿灯 Active、Session 页持续显示「Authenticated — automation can run」、Dashboard 的「会话未激活」横幅永不出现（Dashboard.tsx:128-133 判的是 `session.data.status`）；用户在自动化其实已被服务端 paused 的错觉下错过抢课窗口。这是本次审计中唯一「核心功能静默失效 + UI 主动误导」的路径。
- **用户可见**: 会（UI 会主动骗人：显示 Active 但已停止轮询）
- **状态**: 新增
- **修复方向**: 给 session 资源加事件驱动刷新（收到 warn/error 级事件时 `session.refetch()`），并提供不主动探测 Minerva 的本地会话快照端点供轮询——**不要**按原报告做 60-120s 轮询 `GET /api/session`，该端点会真实 `page.goto(PROTECTED_PROBE_URL)`，违反本项目 pacing 设计（`i18n/index.ts:55`），账号风险高于它要修的问题。
- **证据**: `DataContext.tsx:19` 的 `useResource(() => api.getSession())` 只在挂载时执行一次（useResource.ts:51-53），而 DataProvider 挂在 `main.tsx:12` 根部，整个会话生命周期内不会重新挂载（路由切换只重挂 `<Outlet/>`）。全仓 `grep session.refetch` 仅命中 `Session.tsx:63`（登录按钮内）与测试；`Session.tsx:41-55` 的轮询在 `status !== 'logging-in'` 时立即 return。`server.ts:149-161` 的 `GET /api/session` 内部已有懒校验（会调 `deps.session.isLoggedIn()`），能力存在但客户端从不使用。

### Q8 [high] 主开关语义由课程状态而非引擎状态决定：初次设置后它显示「全部停止」，第一次点击执行 stop-all

- **位置**: `packages/web/src/pages/Dashboard.tsx:103-126,140`；`packages/web/src/components/SchedulerToggle.tsx:13-29`；`packages/server/src/store/store.ts:107-112`；`packages/server/src/api/server.ts:95-99,205-210`；`packages/web/src/pages/Courses.tsx:29-37`
- **来源**: 审计线 D（A1）
- **触发**: 按 `README.zh.md:136-139` 的首次使用流程：登录 → Courses 页添加课程（前端 body 不含 status，Courses.tsx:29-37）→ `POST /api/targets`（server.ts:95-99）→ `store.addTarget` 落到 `status: input.status ?? 'watching'`（store.ts:111）→ 回 Dashboard，`anyWatching=true`（Dashboard.tsx:106/126），`SchedulerToggle running={anyWatching}`（:140）→ 渲染成「监控 · 运行中 / ■ 全部停止」→ 用户第一次点主按钮走 anyWatching 分支调 `api.stopAll()`（:114）→ stop-all 把 watching 全改 paused 并 `scheduler.stop()`（server.ts:205-210）。此时 `main.ts` 全篇无 `scheduler.start()`（已 grep 确认：`scheduler.start()` 仅出现在 server.ts:189/201 的路由内），引擎从未启动。
- **后果**: 第一次点击实际得到「暂停课程 + 停止引擎」，控制台不新增任何轮询日志（stop-all / `scheduler.stop` 均不写事件），与用户期望完全相反；UI 还有第二处同源误导——顶部 Ticker 的「监控中 N」取自 `target.status`（App.tsx:37），引擎停着却显示有课程在监控。唯一恢复方式是再点一次主按钮（标签此时才变「全部启动」）或重启进程。
- **用户可见**: 会（首次使用第一步就撞到，且不知道该再点一次）
- **状态**: 已知报障根因（「必须重启再点全部开始才正常」的直接原因）
- **修复方向**: 把按钮的 running/动作绑定 `GET /api/scheduler` 的真实 running（回到 p7b 计划设计），或让 `POST /api/targets` 明确决定新目标状态（默认 paused，与 boot 归一化一致），不要再用 `target.status` 代理引擎状态。
- **证据**: 历史证据双重确认：`docs/superpowers/plans/2026-06-02-p7b-web-pages.md:579-588` 原计划用 `running={scheduler.data?.running ?? false}`（引擎状态），提交 8b60287 的子提交 “fix(web): master toggle reflects watching courses, not the engine flag” 改成由 anyWatching 驱动；Dashboard.tsx:103-105 注释即该意图自述。修正原报告两处：(1) README「启动时每门课都是暂停」作用域是进程启动，由 `pauseAllWatching()` 真实执行，「与 README 相反」表述不准确；(2)「重新编辑/添加课程即可恢复」不成立——编辑只发查询字段不改 status，重新添加只会再造一个 watching 目标重复触发同一陷阱。

### Q9 [high] Stop all / Pause 无法中断已经通过状态检查的周期：停止后仍会提交注册并把状态改回 registered

- **位置**: `packages/server/src/scheduler/scheduler.ts:93-96,105,121,183,225-256,320-323`；`packages/server/src/api/server.ts:205-210`；`packages/web/src/pages/Dashboard.tsx:69-85`
- **来源**: 审计线 A（A5）、D（A9）——同一根因，合并
- **触发**: 目标 A 处于 watching，某次 tick 已把它取出并在 :95-96 校验过状态；随后周期 await `isLoggedIn()`（:105）与 `checkCourse()`（:121，内部 9 次 `humanPause()` 加多次导航，约 30-60s）。用户在这段窗口里点「Stop all」（server.ts:205-210：watching→paused 并 `scheduler.stop()`）或课程卡的「Pause」（Dashboard.tsx:75 只 PATCH status），但 A 的周期不再重读状态，继续走到 :183 `actor.act()` 提交注册，最后 `applyOutcome` 把状态写成 registered/waitlisted（:230/:235），覆盖用户刚设的 paused。
- **后果**: 用户在「已经停了」之后仍被注册/候补，停止语义被无声撤销，课程卡从 paused 跳回 registered，只能去 Minerva 退课；`stop()` 只是 `clearInterval`（:320-323），既不取消在飞周期也不等待收尾。
- **用户可见**: 会（点完停止后仍收到注册结果，且只能手动退课）
- **状态**: 已知报障根因
- **修复方向**: `act()` 前重新读取 `store.getTarget(targetId)?.status === 'watching'`（不满足则中止本轮），或引入 `stopRequested`/generation 令牌，`stop()` 时递增；`stop()` 至少标记「取消在飞周期」。
- **证据**: `runCycle` 只在开头读一次状态：`const target = store.getTarget(targetId); if (!target || target.status !== 'watching') return;`（:93-96），此后到 :183 之间无任何状态复检或取消令牌；窗口长度（30-60s）与操作可达性均已核实（Pause/Stop all 按钮任何时候都可用）。

### Q10 [high] 保存预算设置后 ticker 立刻渲染伪造进度（把旧上限当成已用次数）

- **位置**: `packages/web/src/App.tsx:14-15,36-43`；`packages/web/src/pages/Settings.tsx:83-84`；`packages/web/src/pages/Dashboard.tsx:38-43`；`packages/server/src/api/server.ts:226`；`packages/server/src/budget/budget.ts:23-30`
- **来源**: 审计线 C（C1）
- **触发**: ① 当天 0 次查询（`main.ts:12` 启动时把所有 watching 目标暂停），store 里 `queryBudget=1000`。② 打开控制台：`DataContext.tsx:18-22` 并发拉 5 个资源，settle 后 `settings.data.queryBudget=1000`、`budget.data={query:1000,register:20}`（budget.ts:27），`App.tsx:40` 算得 `1000-1000=0`，ticker 显示 0/1000。③ 进「设置」页把「每日查询预算」从 1000 改成 10000 点「保存设置」。④ `Settings.tsx:83` 发 `PUT /api/settings`（服务端确实已持久化 10000，server.ts:141 → store.ts:173），紧接着 `Settings.tsx:84` 只 `await settings.refetch()`。⑤ `App.tsx:14` 取到新上限 10000，`App.tsx:40` 得 `10000-1000=9000`，`Ticker.tsx:40` 原样输出 9000/10000；只要用户还停在设置页或任何非 Dashboard 页面，该错误值一直保留。⑥ 负值路径：把预算下调到低于 stale remaining（今天已查 5 次、客户端最后一次拿到的 `budget.data.query=995`，上限从 1000 改成 100）得 `100-995=-895` → 渲染 `-895/100`，单标签页即可达，`Ticker.tsx:40` 无 clamp。
- **后果**: 应用最显眼的「今日查询/注册」进度在用户刚改完上限时是确定性的伪造值（把旧上限当成已用次数），直接误导用户判断当天还剩多少配额；同一缺陷对注册预算同样成立（`App.tsx:42`，20→200 时显示 180/200）。影响面仅限展示层——`budget.ts:7-13` 的 `canQuery/canRegister` 与 ticker 无关，服务端守卫不受污染——但这是用户唯一能看到的配额信息。
- **用户可见**: 会（报障 1 的现象本身）
- **状态**: 已知报障根因（报障 1 的直接根因）
- **修复方向**: 让 `GET /api/budget` 在同一个 handler 里读一次 settings + 一次 dailyOps，返回原子快照 `{used, limit, remaining}`，ticker 只展示该对象并删除 `App.tsx:40/42` 的减法拼接；保存设置成功后同时 `await Promise.all([settings.refetch(), budget.refetch()])`（`Settings.tsx:83` 已拿到 PUT 返回值，也可直接用它更新 settings 资源）。
- **证据**: `budget.ts:23-29` 的 `remaining()` 只返回 clamp 到 ≥0 的剩余量；`App.tsx:40/42` 用 `used = L(新 settings 上限) - R(旧 budget 快照剩余)`。`grep refetch()` 确认全前端仅 `Dashboard.tsx:41` 一处 refetch budget，且需事件流到达且 Dashboard 已挂载（`useEventStream.ts:40` 在 WS 连上时用 `server.ts:240` 推送的 `{type:'recent'}` 快照重新播种 events，这解释了报障里「开始轮询之后就正常了」）。注册预算同理（20→200 显示 180/200）。「字面 9000/1000 数学上不可能」的子论断成立：used=L−R、Ticker 分子分母同源于同一次渲染的 L，且 `budget.ts:27` 保证 R≥0。

### Q11 [medium] 启动时把所有 watching 目标静默改为 paused，不写任何事件，监控停止无迹可查

- **位置**: `packages/server/src/api/main.ts:12-13`；`packages/server/src/store/store.ts:134-144`
- **来源**: 审计线 B（A7）
- **触发**: 任何一次 API 进程重启（正常重启、用户 Ctrl+C、或 Q1 描述的崩溃）。
- **后果**: `pauseAllWatching()` 直接把 status 从 watching 改成 paused 并落盘，不产生任何 LogEvent、不发 WS 事件、不入通知（`grep pauseAllWatching` 仅命中 store.ts:134 定义与 main.ts:12 调用，全仓无其他补记事件之处）；`main.ts:13` 只在服务端 stdout 打一行 `Reset N watching target(s) to paused on startup.`，前端看不到。用户回来只看到一排 paused 卡片和空荡荡的日志控制台，无从知道「这些原本在盯位、是重启把它们停掉的」。若这次重启正好源于 Q1 的崩溃，用户看到的结果是监控无声无息地停了，而日志里最后一条可能是半小时前的正常轮询记录。
- **用户可见**: 会（重启后监控全停且日志无任何解释）
- **状态**: 已知报障根因（保留 boot 复位为 paused 的显式设计意图，缺的是告知）
- **修复方向**: 在 `pauseAllWatching()` 之后由 `main.ts` 通过事件流记一条 warn 事件（例如 “Reset N watching target(s) to paused on startup”），前端即可在控制台看到原因；或保留 watching 并在 UI 上提示需手动恢复。
- **证据**: `main.ts:12` 调用 `runtime.store.pauseAllWatching()`；`store.ts:134-144` 的实现只做 `t.status = 'paused'` 与 `this.save()`，没有 `appendEvent`。设计意图提示：boot 不自动恢复轮询是显式保证（提交 8b60287 的 “On boot, reset every persisted 'watching' target to 'paused' so the app never resumes polling on its own”，另见 `main.ts:10-11`、`store.ts:131-133` 注释）。与 Q8 同根因（状态是磁盘态、行为是引擎态），改动点不同故分列；如需压缩条目可并入 Q8。

### Q12 [high] 会话状态与真实浏览器上下文解耦：UI 显示已登录、引擎却从未启动，运行中加课必中同一陷阱

- **位置**: `packages/server/src/api/main.ts:7-17`（无 `scheduler.start()`）；`packages/server/src/api/server.ts:83,149-161,175,188-203`；`packages/web/src/pages/Session.tsx:41-55`
- **来源**: 审计线 D（A4，原 high，本条保留 high：首次使用与运行中加课都会撞到）；与 E（A1）「前端闸门失效」子论断同源
- **触发**: 运行中途新增课程（`POST /api/targets` 默认写 watching）→ 引擎未启动但磁盘状态为 watching，UI 显示「监控 · 运行中」；此时点主按钮执行的是 stop-all（见 Q8）。要恢复必须 Ctrl+C 彻底重启：`main.ts:12` 在 `createRuntime` 之后执行一次 `pauseAllWatching()`，仅做 watching → paused（store.ts:136-140），之后 start-all（server.ts:198-203）才是唯一「恢复 paused + 启动引擎」的原子路径；此外没有任何代码把 watching 归一化回 paused。另一路：服务端 `sessionStatus` 与真实浏览器上下文解耦（server.ts:83 是进程内变量，`/api/scheduler/start|start-all` 不检查是否 `launch()` 过），用户点 Start all 后 ≤30 秒可能直接按 Q1 崩掉进程；`Session.tsx:41-55` 仅在 `logging-in` 时轮询，因此用户看到的仍是 authenticated。
- **后果**: 同一进程生命周期内的确定性错位：运行中加课必中该陷阱，若在加课之前重启则不中，重启只在下一次加课之前有效。
- **用户可见**: 会（UI 显示「运行中」但一次轮询都不会发生，且第一次点击方向相反）
- **状态**: 已知报障根因（报障 2「必须重启才正常」）
- **修复方向**: 同 Q8——UI 改读 `GET /api/scheduler` 的真实 running（或让 `POST /api/targets` 默认 paused），保留 boot 归一化作为「启动不自动轮询」的保证；`/api/scheduler/start*` 增加「会话/浏览器上下文不可用」的显式拒绝或友好提示。
- **证据**: `grep scheduler.start()` 仅命中 `server.ts:189/201`（两个路由内）与 `scheduler.test.ts:362`，`main.ts` 从不启动引擎；`pauseAllWatching()` 只在 `createRuntime` 之后执行一次。降级说明：原报告称「问题表现随机化」不成立，它在同一进程生命周期内是确定性的。

---

## P2 — 可排队

### Q13 [high] 资源加载错误被吞成空态/永久「加载中」/默认预算，无错误条与重试入口

- **位置**: `packages/web/src/lib/useResource.ts:34-53`；`packages/web/src/pages/Settings.tsx:61-68,84-85`；`packages/web/src/App.tsx:14-15,40-42`；`packages/web/src/pages/Dashboard.tsx:125,148`；`packages/web/src/pages/Courses.tsx:14,61`
- **来源**: 审计线 C（C2）、F（F2）——同一根因，合并
- **触发**: 服务端忙、被代理挡一次或后端重启导致 `GET /api/settings`（或 targets/budget）失败；`useResource.ts:44-48` 只 `setError`、不 rethrow、不重试，挂载 effect（:51-53，依赖是稳定的 refetch）不会重跑；全 `packages/web/src` 无一处读 `resource.error`（grep 只命中 `useResource.test.tsx` 与样式键），于是 `settings.data` 在本次 SPA 会话内永远 undefined。变体 A（设置页）：`Settings.tsx:68` 的 `if(!form)` 依赖 `settings.data`（:62），页面停在「加载设置中…」，无任何错误提示或重试入口。变体 B：`App.tsx:14` 退回兜底 100（`shared/src/store-types.ts:80`）而 `budget.data` 可能已是真实值 → `100-10000=-9900` → 显示 -9900/100。变体 B′：反过来 `GET /api/budget` 失败而 settings 成功时，`budget.data?.query ?? queryBudget` 让分子退化成 0 → 显示 0/1000，看上去「今天一次都没查过」，实际可能预算已耗尽且 scheduler.ts:99-103 已把轮询推迟到明天。变体 C：PUT 成功但随后的 `settings.refetch()` 失败不会 reject（:44-47 只在内部 catch），`Settings.tsx:85` 仍执行 `setSaved(true)`。
- **后果**: 单次瞬时失败变成长期状态错乱：顶部进度用硬编码默认值与真实 remaining 混算（既可显示离谱负数，也可显示看起来正常的 0/L），设置页在本次会话内无法打开、用户既不被告知原因也没有重试入口，只能刷新整页恢复；失败被渲染成「还没有监控任何课程 / 暂无课程」，用户可能以为配置被清空而重加课程（`store.ts:99-116` 的 addTarget 无去重、server.ts:95-99 也不查重），产生重复 target。三处均违反设计文档 §6「REST 失败要有行内错误条」。
- **用户可见**: 会（页面直接坏掉或显示错误数字）
- **状态**: 新增
- **修复方向**: 消费者侧统一补错误条 + 重试按钮，空态渲染前先判 loading/error；ticker 在 settings/budget 出错时显示占位符而非默认预算；`Settings.tsx:85` 的「已保存」以 PUT 成功为准，随后的 refetch 失败单独提示。
- **证据**: 逐条复核成立（`useResource.ts:16-18,44-45,57`；`Settings.tsx:61-68`；`Dashboard.tsx:125,148`；`Courses.tsx:14,61`；`App.tsx:40-43`）。设计文档 §6 明确要求行内错误条/toast（`docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md:93`），实现未做。被修正的定性：变体 C 不是「假成功」，PUT 确实已落库，真实缺陷是 `settings.data` 停在旧快照。

### Q14 [medium] 停止/暂停不取消在飞周期：用户在「已经停了」之后仍被注册，课程卡从 paused 跳回 registered

- **位置**: `packages/server/src/scheduler/scheduler.ts:320-323,96,183`；`packages/server/src/api/server.ts:205-210`；`packages/web/src/pages/Dashboard.tsx:69-85`
- **来源**: 审计线 A（A5）、D（A9）——与 Q9 同一根因的暂停/停止侧面；Q9 保留为 high（含 Status 覆写语义），本条只记 `stop()` 不取消在飞周期这一实现缺口
- **触发**: 用户在某一轮进行中（查询 + 多次 `humanPause`，常达数十秒）点「全部停止」或单课「暂停」：`scheduler.stop()` 只 `clearInterval`（:320-323），`runCycle` 只在开头检查一次状态（:96），之后到 `actor.act`（:183）之间没有任何状态复检或取消机制。
- **后果**: 该轮仍会继续执行，可能提交注册并把状态改成 registered。
- **用户可见**: 会
- **状态**: 已知报障根因
- **修复方向**: 同 Q9——`stop()` 需要标记「取消在飞周期」，并在 `act()` 前复检状态。
- **证据**: 代码路径已逐行确认：`stop()` 仅 `clearInterval`，`runCycle` 状态检查只在入口一次，act 前无复检、无取消令牌。与 Q9 共用修复，排在 Q9 之后。

### Q15 [medium] 登录失败原因被完全丢弃，浏览器没起来或 SSO 卡住时用户只能看到「未登录」

- **位置**: `packages/server/src/api/server.ts:162-184`（catch 在 :176-177）；`packages/web/src/pages/Session.tsx:57-69`；`packages/web/src/lib/api.ts:60`
- **来源**: 审计线 B（A6）
- **触发**: 点击会话页 Login 后出现：Chromium 未安装（未跑 browser:install，`launchPersistentContext` 直接抛 Executable doesn't exist）、profile 目录被占用、SSO 卡到超时、登录中被关窗。
- **后果**: `catch { sessionStatus = 'logged-out'; }` 既不打日志也不发事件；前端只能显示「已登出 —— 登录后轮询才能运行」（`i18n/index.ts:62`），用户无法区分「确实未登录」与「浏览器启动失败」，只能反复点击同一个必败流程。对照 CLI 脚本会把失败打出来（`register-script.ts:44-47`）。关键机制：`POST /api/session/login` 同步返回 `{started:true}`，真正工作在未被 await 的 async IIFE 中，因此 `api.login()`（api.ts:60）立刻 resolve，`await session.refetch()` 只读到 'logging-in'，`Session.tsx:64-66` 的 catch/errbar 对登录失败永不触发，失败最终只表现为状态回落 'logged-out'。
- **用户可见**: 会（登录按钮点了没反应/失败原因不可见）
- **状态**: 新增（本机实测即撞到：所需 chromium_headless_shell-1223 未安装）
- **修复方向**: catch 中保留 error，`console.error` 并通过 store/WS 事件流广播 error 事件（UI 的 errbar 已有展示位）；把登录改为返回可轮询的错误码/事件，而不是只靠 sessionStatus。
- **证据**: 逐条核实成立。实测 `launchPersistentContext` 抛 `Executable doesn't exist at ...chrome-headless-shell.exe`；`grep closeSession` 确认仅三个 CLI 脚本使用，API 进程无 SIGINT/SIGTERM 或退出钩子。已证伪的子论断：原报告称崩溃/强退后孤儿 Chromium 占用 `.browser-profile`——实测父进程退出时其 spawn 的子进程随父进程终止，该因果链不成立，已从后果中剔除。

### Q16 [medium] in-flight 命中时静默丢弃并发轮次，`/run` 仍返回 `started:true`，「立即执行」可能整轮无结果

- **位置**: `packages/server/src/scheduler/scheduler.ts:60-62,80-91,329-338`；`packages/server/src/api/server.ts:115-125`；`packages/web/src/pages/Dashboard.tsx:87-98`；`packages/web/src/lib/api.ts:49`
- **来源**: 审计线 B（A4）、D（A6）——同一守卫的「丢弃无反馈」侧面，合并
- **触发**: 目标已有轮次在跑时，用户点「⚡ 立即执行」→ `runOnce` 在 inFlight 命中时直接 return（:81-84）→ `/run` 无论是否被丢弃都返回 `started:true`（server.ts:123-124）→ 前端 `onRun` 在响应回来即清除「… 执行中」（Dashboard.tsx:87-98），按钮只闪一下。
- **后果**: 本次点击没有被执行的语义对用户不可见（返回值无法区分接受与丢弃），带 force 的一键执行会真的丢掉本次诉求；但因目标处于 inFlight 即意味此刻正在为它跑一轮，用户「现在查一次」的诉求基本已被满足，等一轮即可重试。
- **用户可见**: 会（按钮闪一下什么都没发生；不过会写一条 info 事件）
- **状态**: 新增
- **修复方向**: inFlight 命中时把结果回传（`/run` 返回 `{started:false, reason:'in progress'}`）或排队执行一次，前端据此提示「正在执行中」，并让 running 状态跟随事件流中该目标的周期结束而非 POST 返回。
- **证据**: 修正原报告两处不准确表述：(1) 命中时会写一条 info 事件（`Run already in progress for this target — skipping concurrent run`，:82），经 `appendEvent → onEvent → broadcast`（runtime.ts:34-37、server.ts:266-276）到前端并被 Console 渲染，故「既无已轮询也无报错」不准确；(2) 跳过并发是显式有意设计（:60-61 注释、`scheduler.test.ts:326-355` “skips a concurrent run of the same target (no double registration)”），去掉守卫会引入重复注册，比现状更糟。

### Q17 [medium] 设置表单只初始化一次 + PUT 全量覆盖：并发保存会静默回滚别人刚改的预算，甚至关掉 dry-run

- **位置**: `packages/web/src/pages/Settings.tsx:61-66,83`；`packages/server/src/api/server.ts:129-146`；`packages/server/src/store/store.ts:172-176`
- **来源**: 审计线 C（C3）
- **触发**: 标签页 A 停在设置页（`form.queryBudget=1000`），标签页 B 把查询预算改成 10000 并保存；回到 A，只切一下 dry-run 开关再点保存 → 请求体里带着 A 的旧 `queryBudget:1000`，`store.setSettings` 是浅合并、后写覆盖（store.ts:173），10000 被静默改回 1000。复现要求「第二个客户端也停在设置页」：同一标签页内不存在第二条 settings 写入路径（settings 资源只有挂载与 `Settings.tsx:84` 三处触发），所以单标签页流程不可达。
- **后果**: 用户刚确认生效的预算被另一次无关保存悄悄回滚，无任何提示；由于 PUT 提交的就是整份表单，回滚后的界面与服务端其实是自洽的，只有重新挂载表单才会看到被改回的值。真正值得保留这条的理由是它同样能回滚 dryRun——`scheduler.ts:161` 在每次决定动作前实时读 `store.getSettings().dryRun`，一个陈旧的 `dryRun:false` 表单会把用户刚开启的演练模式关掉，使应用开始真实注册。
- **用户可见**: 会（但需双客户端各自停在设置页）
- **状态**: 新增
- **修复方向**: 用 PUT 的返回值（或 `settings.data` 变化）重新同步表单，并在提交时只发送相对服务器快照真正变更过的字段（或带版本号/updatedAt 做乐观并发校验，冲突时提示）。
- **证据**: 机制与行号全部成立。整对象 PUT 是有意设计——`server.ts:132-135` 注释明确说明「UI saves the whole settings object」，因此缺的是并发保护而不是「覆盖语义写错」。

### Q18 [medium] WebSocket 侧不校验 Origin（跨站可订阅全部事件）

- **位置**: `packages/server/src/api/server.ts:236,240,244`
- **来源**: 审计线 E（A3）
- **触发 / 后果 / 证据 / 修复方向**: 见 Q6（同一条发现的安全侧面）。此处仅作为独立待办保留：若本次只修 Q6 的读写端 Origin 校验，请一并覆盖 WebSocket 升级握手（`@fastify/websocket` 无 `verifyClient`）。
- **用户可见**: 不会
- **状态**: 新增

### Q19 [medium] 邮件字段不完整时 PUT 静默省略 email，UI 报「已保存 ✓」但服务端保留旧 SMTP，且无法从界面清空

- **位置**: `packages/web/src/pages/Settings.tsx:70,73-90,144`；`packages/web/src/lib/api.ts:52-57`；`packages/server/src/api/server.ts:50-56,65,141`
- **来源**: 审计线 C（C6）
- **触发**: 用户此前存过 SMTP 配置；现在把 host/user/pass/to 清空（`emailComplete = Boolean(...)` 为 false）且「邮件」通知未勾选（勾选时会被 `Settings.tsx:73-77` 提前拦住并提示 `settings.emailRequired`），点保存 → `JSON.stringify` 丢掉了值为 undefined 的 email 键，服务端 `store.setSettings` 浅合并保留旧 SMTP，而表单里显示为空、界面照旧显示「已保存 ✓」。客户端也确实没有任何「清空 email」的表达方式：`server.ts:65` 的 emailSchema 要求 host/port/user/pass/to 全部合法，null 会被 400。附带：saved 徽标（`Settings.tsx:59/85/156`）在保存成功后不会因后续编辑而清除，界面对一份并未持久化的状态作断言。
- **后果**: 旧 SMTP 凭据（含口令）长期留在 `data/store.json` 中且无法从界面清除；「表单值 = 服务端值」的前提被破坏，后续任何一次保存都会继续保留这份不可见的旧配置。实际风险有限：该场景下 `notify.email === false`，服务端不会真发信。
- **用户可见**: 会（界面声称已保存，实际保留旧配置）
- **状态**: 新增
- **修复方向**: 显式区分「不改动 email」与「清空 email」（发送 `email: null` 并放宽 schema，或单独的 `DELETE /api/settings/email`），保存后用服务端返回值回填表单，并在表单再次变化时清掉「已保存」徽标。
- **证据**: 行号有 1 行偏差（`setSaved(true)` 在 85、catch 在 86-89），语义完全正确；`Settings.tsx:80-82` 的注释表明「完整才持久化、避免用半截配置覆盖」是有意为之，缺的是「清空」这一显式语义。

### Q20 [medium] `error` 后的恢复语义缺失在卡片侧，且没有把跳过的课程数告诉用户

- **位置**: `packages/web/src/components/CourseCard.tsx:19-31,49-59,63`；`packages/server/src/api/server.ts:198-203`；`packages/web/src/pages/Dashboard.tsx:113-116`
- **来源**: 审计线 A（A2）、D（A7）——Q3 的 UI/接口侧面
- **触发**: 目标进入 error 后，`PAUSABLE`/`RESUMABLE` 都不含 error（CourseCard.tsx:22-23），「⚡ Register now」disabled（:29,63），start-all 只捞 paused（server.ts:199）且前端不读 `{running:true, resumed:N}`（Dashboard.tsx:115）。
- **后果**: 用户看不到「有几门课因为错误被跳过」，唯一的自我修复动作（按日志提示改 CRN/学期/科目/学院）静默无效。
- **用户可见**: 会
- **状态**: 已知报障根因
- **修复方向**: 同 Q3（补显式恢复入口），并让 start-all 的 `resumed`/跳过数在前端可见。
- **证据**: `server.test.ts:346-365` 断言 error 在 start-all 后保持不变，固化的是「有意跳过」而非「有意不可恢复」。

### Q21 [medium] 提交后不等结果页解析（注册流程的成功判定依赖运气）

- **位置**: `packages/server/src/minerva/register-client.ts:48-52,67-72`
- **来源**: 审计线 B（A2）——Q4 的流程侧面，本清单只保留一次实质缺陷（Q4），此处仅登记「waitForLoadState 在已触发 DCL 的 document 上是空操作」这一实现依据与修复锚点
- **触发 / 后果**: 见 Q4。
- **用户可见**: 会
- **状态**: 已知报障根因
- **修复方向**: 用结果页锚点等待替代 `waitForLoadState('domcontentloaded')`（同 Q4）。

### Q22 [medium] 解析失败与「CRN 未找到」不可区分，一次页面改版即可让目标被永久停止

- **位置**: `packages/server/src/minerva/parse-sections.ts:15-16,41-42`；`packages/server/src/minerva/query-client.ts:65-68`；`packages/server/src/scheduler/scheduler.ts:130-137,199-210`
- **来源**: 审计线 B（A4）
- **触发**: Minerva 结果表 caption 文案变化，或 WL Cap/WL Act/WL Rem 任一列缺失/改名，导致 7 列没认全；或结果页慢到 8 秒 `waitForSelector` 超时后 `content()` 读到不完整文档。
- **后果**: `parseSections` 在「没有 Sections Found 表」和「表头 7 列没认全」两种情况下都返回 `[]`，`checkCourse` 因而返回 null；`scheduler.ts:130-137` 把 null 一律当成失败并给出误导性提示 `CRN ... not found ... — check the CRN, term, subject, course number and faculty`，连续 3 次把目标置为 error 并停止监控。用户拿到错误归因，真实原因是抓取/解析失败。降级理由：`query-client.ts:67` 的 `waitForSelector('table.datadisplaytable', { timeout: 8000 }).catch(() => undefined)` 是真实的上游保护，8 秒内表格出现即能正确解析；结构未变动前该路径不会自行触发。
- **用户可见**: 会（但只在页面改版/结构漂移时）
- **状态**: 新增
- **修复方向**: 让解析层区分「页面无结果」与「页面结构不认识」（返回标志位或抛 ParseError），后者记明确 error 事件且不计入「CRN 不存在」的失败连击，必要时保留上轮 `lastStats`。
- **证据**: 两处 `return []` 语义相同（:15-16 与 :41-42 的 `if (colValues.some((c) => c < 0)) return []`）；`noteFailure` 第 3 次置 `status='error'` 见 :199-210。

### Q23 [medium] 手动「Register now」缺少节流/冷却，可绕过 `nextPollAt` 节奏把每日查询预算烧在手动触发上

- **位置**: `packages/web/src/pages/Dashboard.tsx:87-98`；`packages/server/src/api/server.ts:115-125`；`packages/server/src/scheduler/scheduler.ts:80-91,99-103,329-338`
- **来源**: 审计线 F（F11）
- **触发**: 用户连点「⚡ Register now」。按钮的 running 状态只覆盖 POST 请求在途的瞬间（server.ts:115-125 的「接受」是同步快速返回的，真正的查询/决策/注册异步进行），POST 一返回按钮立刻恢复可点。
- **后果**: 与自动轮询不同，手动执行不经过 `nextPollAt` 节流（`tick()` 只跑 nextPollAt 到期的 target，而 `/run` 直接调 `runTarget(id)` → `runOnce` 忽略 `nextPollAt`）。唯一的节流是每个 target 的 in-flight 守卫（并发重复点击只会记一行 Run already in progress 并跳过），因此串行连点仍会逐次真实查询 Minerva，唯一硬约束是每日查询预算（:99-103）。这与本项目反复强调的 pacing 意图相冲突（`i18n/index.ts:55`：抖动与低轮询频率是为了避免被 McGill 服务器判定为异常/机器人行为，进而被限流或锁定账号）。
- **用户可见**: 会（用户主动连点才会撞到）
- **状态**: 新增
- **修复方向**: 给「Register now」加客户端冷却（该 target 上一轮结束前二次确认），或在服务端 `/api/targets/:id/run` 记录 `lastForcedRunAt`，冷却期内返回 `{started:false, reason:'cooldown'}`。
- **证据**: 服务端无任何 `lastForcedRunAt`/冷却时间检查（server.ts:119-124 仅拒非 watching）；`api.ts:49` 的 `runTarget` 为无体 POST；`scheduler.ts:80-91` 为唯一的 in-flight 守卫。评为 medium 而非 high：仅本地单用户、需用户主动连点、且有 in-flight 守卫与每日预算兜底。

### Q24 [medium] 预算拉伸（×3）会波及 notify 目标与 dry-run，且到午夜无上限、改预算不重排

- **位置**: `packages/server/src/scheduler/scheduler.ts:260-283,99-103,288-300,145-187`；`packages/server/src/api/server.ts:58-68,136-144,226`；`packages/web/src/pages/Settings.tsx:102`
- **来源**: 审计线 A（A7）、C（C5）——同一 `scheduleNext` 机制，合并
- **触发**: ① ×3 分支（:276-279 `if (rem.register <= 0 && remainingQuery > 0) baseMin = Math.max(baseMin * 3, 60)`）没有任何 mode/dryRun 判断，`:145,157,169,177,187,243,248,253` 的 `scheduleNext` 都会命中；`registerBudget` 设 0 合法（server.ts:63 `z.number().min(0)`，Settings 数字输入框无 min 属性），或当天 20 次注册尝试用完后即进入该状态，默认配置（poll=30、jitter=3、queryBudget=100）下单目标 baseMin 由 30 变成 `max(30*3, 60)` = 90 分钟。② `pollsPerTarget = remainingQuery / activeCount < 1` 时 `baseMin = minutesUntilMidnight / pollsPerTarget` 没有任何上界。③ `scheduleNext` 只在目标自己下一轮周期时被调用，本地午夜没有重排钩子；`rescheduleWatching()` 的唯一调用点是 `PUT /api/settings` 且只在 `pollIntervalMinutes/jitterMinutes` 变化时触发（server.ts:137-144），改 `queryBudget/registerBudget` 不会重排（`server.test.ts:341-342` 断言了该行为）。
- **后果**: notify 模式在 :154-159 就 return，dryRun 在 :161-171 return，两条路径都到不了 `budget.recordRegister`（只在 :185/:190 调用），即它们永不消耗注册预算却被一起 ×3 减速；用户把工具设成「只通知/从不自动注册」后实际检查频率变成配置值的 1/3。真正越界的危害只在 `remainingQuery < activeCount`（当天剩余查询次数少于监控课程数）时出现，此时多轮询会超预算。其余实际影响：午夜预算重置后没有代码重算被拉伸的 `nextPollAt`，目标可睡过重置点、新鲜预算空转（默认量级数小时，极小预算或 ×3 叠加可达一天以上）；改 queryBudget/registerBudget 后不重排，用户「把预算调大」的修复要等目标自己醒才生效。`scheduleNext` 不产生任何事件（无 `this.log`），用户完全看不到周期被拉长。
- **用户可见**: 会（表现为「设置改了没反应」「明明在监控却几小时不轮询」）
- **状态**: 新增（×3 对 auto 目标是有意为之，缺的是 mode/dryRun 守卫与上界/重排）
- **修复方向**: 仅在 `target.mode === 'auto' && !store.getSettings().dryRun` 时应用 ×3；把拉伸结果 clamp 到 `msUntilLocalMidnight(now)`；在 queryBudget/registerBudget 变化时与 pause→watching 恢复后一并调用 `rescheduleWatching()`。
- **证据**: 算术无误（2 门课、remaining=1、正午 720 分钟 → 1440 分钟 = 24h），但 `minutesUntilMidnight / pollsPerTarget = T·N/R` 正是「把当天剩余额度按课程数摊平到当天剩余时间」的公平份额，24h 是预算不足的正确结果而非算错；N=5,R=2 时拉伸给 30h 而稳态公平份额是 60h，即它在多轮询而非少轮询。默认 `queryBudget=100`（`shared/src/store-types.ts:80`）下拉伸受限于当天剩余尾部时段，实测量级数小时。

### Q25 [low] 内存里持有 store 的活对象，用户编辑可导致「按旧 CRN 决策、对新 CRN 动手」

- **位置**: `packages/server/src/scheduler/scheduler.ts:95,111-117,183`；`packages/server/src/store/store.ts:95-97,118-124`
- **来源**: 审计线 D（A10）
- **触发**: 用户在「查询完成 → 执行」窗口内修改课程 CRN：`store.getTarget()` 直接返回数组里的对象（store.ts:95-97），`updateTarget` 用 `Object.assign` 原地修改（:121），所以 `runCycle` 在 :95 取得的 target 会在整轮中随用户编辑而变；查询用的是 :111-117 的快照（旧 CRN），执行用的是 :183 的实时 `target.targetCrn`。
- **后果**: 出现「按旧 CRN 的余量决策、对新 CRN 动手」的错配，可能对用户新改的课程目标执行注册动作。
- **用户可见**: 会（需恰好在窗口内编辑）
- **状态**: 新增
- **修复方向**: 在 `runCycle` 开头做一次浅拷贝（或让 `getTarget/updateTarget` 返回不可变副本）。
- **证据**: 根因是 `getTarget` 返回活引用 + `Object.assign` 原地修改，属共享可变状态问题。

### Q26 [low] 登录页/超时页识别只靠两段 body 文本，兜底规则却把任何 pban1 URL 判为已登录

- **位置**: `packages/server/src/session/session-status.ts:4-12,14-19,20,35-39`；`packages/server/src/session/session-manager.ts:47-49,73-76`
- **来源**: 审计线 B（A5）
- **触发**: 会话在别处被挤掉/自然过期后，`checkStatus()` 探测 `bwskfreg.P_AltPin`；若此时 body 文本取不到或不含 `login to minerva` / `user login`，判定落到第 3 条规则 `if (url.includes(AUTH_BASE)) return 'authenticated'`。
- **后果**: 超时会话被判为 authenticated → `ensureLoggedIn` 提前 return（session-manager.ts:76），调度器用死会话继续查询，每轮查询在 `selectOption` 上耗 30s 后抛错，连错 3 次目标变 error；用户看到「查询失败」而非「请重新登录」。
- **用户可见**: 会（表现为「查询失败/课程变 ERROR」而非「请重新登录」）
- **状态**: 新增（未验证脆弱性）
- **修复方向**: 把 `page.title()` 一并纳入判定（title 是最强信号却完全没被使用），或在 pban1 页面加一条正向「已登录」锚点（登录表单不存在 / 出现 Quick Add-Drop 表单），不要用 URL 兜底推断已登录。
- **证据**: 规则顺序、行号、注释、测试全部核对无误：`session-status.ts:14-19` 注释明确写 Banner serves that page at a pban1 URL (title "User Login")，测试 `session-status.test.ts:41-48` 正是在 pban1 URL 上用 body 文案覆盖；两条 `LOGIN_URL_MARKERS`（:4-12）不含 pban1 超时页路径；`session-manager.ts:47-49` 只读 `innerText('body')` 且把读取失败吞成空串，`<title>` 完全不参与判定。降级理由：整条推断唯一支点是「真实 Minerva 超时页 body 不含这两段小写文案」，而注释自述该页 title 为 User Login、Banner 超时页通常也会出现 User Login/Please login 之类字面文本，若如此则第 2 条规则先命中并正确判 logged-out；仓库内只有合成 fixture、无法联网访问需登录的校内页面，故为未验证脆弱性。

### Q27 [low] 全局 `error` 状态与「连续 3 次失败」判定缺少可见的失败归因与恢复计数

- **位置**: `packages/server/src/scheduler/scheduler.ts:41-48,199-210`
- **来源**: 审计线 A（A2）、D（A7）——Q3 的计数侧面，作为独立待办保留
- **触发**: `FAILURE_LIMIT = 3`，任何类型错误都计数（含 `parse-register-result.ts:69-70` 把 Time Conflict / Prerequisite / Department Consent 等非 closed/class full/waitlist 提示都归为 error）。
- **后果**: 非瞬时错误（如先修课不满足）也会走满 3 次并进入 Q3 的死状态；`failureStreak` 只存在内存（scheduler.ts:64），进程重启即清零。
- **用户可见**: 会（红色徽章可见，但「为什么失败」需要翻控制台）
- **状态**: 新增
- **修复方向**: 保留 FAILURE_LIMIT，但把「本轮失败原因 + 剩余重试次数」写入卡片可见的 `lastError` 字段，并对不可重试类错误（先修课/时间冲突）直接给出「需人工处理」而不计入同一 streak。
- **证据**: `parse-register-result.ts` 把所有未识别提示归为 error；`noteFailure` 第 3 次置 error 且不重排 `nextPollAt`。

### Q28 [low] 注册结果分类器把「不可重试的注册错误」当瞬时错误，叠满 3 次即永久停摆

- **位置**: `packages/server/src/minerva/parse-register-result.ts:50-71,77`；`packages/server/src/scheduler/scheduler.ts:250-254,199-210`
- **来源**: 审计线 A（A2）、E（A1）——Q3 的分类侧面
- **触发**: Minerva 返回 Time Conflict / Prerequisite / Department Consent / Level Restriction 等 Registration Errors 提示时，解析器一律给 `{ kind: 'error' }`。
- **后果**: 这类错误重试永远不会成功，却会消耗 3 次 streak 并把目标推入 Q3 的 error 死状态；日志文案 `Registration error: ...` 也不提示「这门课你申不了」。
- **用户可见**: 会（最终表现为课程变 ERROR）
- **状态**: 新增
- **修复方向**: 在解析器里区分「可重试错误（系统/网络/暂时）」与「不可重试错误（资格/冲突/先修）」，后者一次性给出明确说明并暂停该目标（不占用失败 streak）。
- **证据**: `parse-register-result.ts:69-70` 的兜底分支；`scheduler.ts:250-254` 的 `case 'error'` 直接 `noteFailure`。

### Q29 [low] `GET /api/events?limit=0` 返回整个日志（`slice(-0)`），且声称覆盖它的测试是空跑

- **位置**: `packages/server/src/api/server.ts:213-219`；`packages/server/src/store/store.ts:157-159`；`packages/server/src/api/server.test.ts:121-124`
- **来源**: 审计线 E（A4）
- **触发**: 对运行中的应用请求 `GET /api/events?limit=0`（或 `limit=`、`limit=-5` 等任何 limit<=0 取值）。`recentEvents(limit)` 直接 `return this.data.events.slice(-limit)`，`slice(-0)` 等价于 `slice(0)` 返回全量，负数经 `Math.max(0,-5)=0` 同样落到 0；空串经 `Number('')=0` 亦然。
- **后果**: 请求 0 条却拿到整份日志（上限为 maxEvents 2000 条），与 `server.ts:216-217` 注释承诺的「negatives clamp to 0; an explicit 0 is honoured」正好相反，属契约违背与信息过量返回；同时 `server.test.ts:121-124` 的 `it('uses limit=0 as zero (not 200)')` 未 seed 数据，`beforeEach(:27-30)` 每次新建临时目录 + 空 Store，`[]` 无论如何都成立，回归时不会变红。
- **用户可见**: 不会
- **状态**: 新增
- **修复方向**: `limit<=0` 直接 `return []`（store 内同样判断），并把该用例改成先 `appendEvent` 再断言 `[]`，顺便补一个负数用例。
- **证据**: 对真实 `buildServer` 实测（seed 2 条事件）：`limit=0` → 200 返回 EVENT-1/EVENT-2；`limit=` → 200 同上；`limit=-5` → 200 同上。`node -e` 验证 `[1,2,3].slice(-0)` → `[1,2,3]`。

### Q30 [low] `POST /api/targets` 对纯空白必填字段返回 500 而非 400，并回显内部实现信息

- **位置**: `packages/server/src/api/server.ts:40-48,95-99`；`packages/server/src/store/store.ts:102-106`
- **来源**: 审计线 E（A5）
- **触发**: `POST /api/targets` 提交 `{"term":" ","subject":"COMP","faculty":"Faculty of Science","courseNumber":"551","targetCrn":"1814","mode":"auto"}`（把空白放到 targetCrn 等任一必填字段上同样触发）。`term: z.string().min(1)`（:41）接受 `" "` → `deps.store.addTarget(parsed.data)`（:98）同步抛出自定义错误 → 路由无 try/catch → Fastify 默认错误处理返回 500。
- **后果**: 返回 500 而非 400，且把内部实现信息（字段名 + 函数名 `addTarget: missing required field "term"`）回显给调用方，属错误语义错误与内部信息泄露。Web 表单因 `CourseForm.tsx:64-78` 对五个必填字段逐个 `.trim()` 后判空而撞不到，只影响脚本/第三方客户端。
- **用户可见**: 不会（UI 撞不到）
- **状态**: 新增
- **修复方向**: 五个必填字段改成 `z.string().trim().min(1)`（zod 阶段即 400），或把 store 的校验错误映射成 400，并给 store 的自定义错误加 `statusCode`。
- **证据**: 实测响应 `500 {"statusCode":500,"error":"Internal Server Error","message":"addTarget: missing required field \"term\""}`。

### Q31 [low] SMTP 密码明文落盘并以明文经 `GET/PUT /api/settings` 原样往返

- **位置**: `packages/server/src/store/store.ts:84-88,172-176`；`packages/server/src/api/server.ts:128`；`packages/shared/src/store-types.ts:61-68`；`packages/web/src/pages/Settings.tsx:64,146`
- **来源**: 审计线 E（A7）
- **触发**: 任意可访问本机 API 的读取路径（DNS rebinding 或同机进程/账号）`GET /api/settings`，即原样拿到 `email.pass`。写入侧：`writeFileSync(tmp, JSON.stringify(this.data, null, 2))`（:86）未传 mode → Node 默认 `0o666 & ~umask`，Linux/macOS 常见 0644（`mkdirSync(d,{recursive:true})` 同理会是 0755），store.json 里凭据即明文 JSON。前端 `Settings.tsx:64,146` 把回读到的密码填回 `type=password` 输入框，保存时整体回传（:83），故该字段必须在读接口出现。
- **后果**: SMTP 凭据（如 Gmail App Password，长期有效）可被读取并用于以用户身份发信；Unix 上默认 0644 使同机其他账号可直接读文件，与文档「never leave your machine」在多用户机器上相悖。
- **用户可见**: 不会
- **状态**: 新增（明文存本地是文档化设计，缺的是最小暴露）
- **修复方向**: 读接口不回传 pass（改为 `hasPassword` 布尔，更新时空值表示保持原值）；`writeFileSync(tmp, data, { mode: 0o600 })` 且目录 0o700；有条件时改用系统钥匙串/safeStorage。
- **证据**: 实测 `GET /api/settings` 响应体含 `"pass":"SECRET-APP-PASSWORD"`；落盘 store.json 明文含 `"pass"`；`writeFileSync(:86)` 未传 mode。修正原报告事实错误：`data/` 已在 `.gitignore(:31-36)`，不会进提交，「data/ 位于 git 工作区内」不构成泄露路径。降级理由：明文存本地是文档化设计（`EMAIL_SETUP.md:47-48`、`store-types.ts:61`、P6 计划 `2026-06-02-p6-api.md:27`），且读取路径与 Q5 同源，暴露级别不高于 Q5。维持独立的理由：读接口回传凭据并非必需。

### Q32 [low] store.json 读取/解析失败一律判为损坏，备份失败后仍以空数据启动并覆盖唯一一份数据

- **位置**: `packages/server/src/store/store.ts:52-82,84-88,114,153,174`
- **来源**: 审计线 A（A6）、E（A8）——同一根因，合并（A 线评 medium，E 线评 low，此处从保守取 low，理由见证据）
- **触发**: `try` 块同时包住 `readFileSync` 与 `JSON.parse`（:54-61），因此「文件存在却读不出来」（Windows 上杀毒/同步/备份进程持句柄导致的 EBUSY/EPERM/EACCES）与「内容非法」走同一分支；该分支兜底是 `renameSync(this.file, corruptPath)`，其自身失败被空 `catch {}` 吞掉（:65-69），此时内存里已是空状态（targets=[]、DEFAULT_SETTINGS、dailyOps 清零，:76-81）而 store.json 仍在原地。用户随后任意一次写操作（`addTarget` :114 / `appendEvent` :153 / `setSettings` :174）都会走 `save()`，无条件 `renameSync(tmp, this.file)`（:87）把这份空状态写回去。
- **后果**: 全部监控课程、设置（含 SMTP 凭据）与日志被清空，且没有 `.corrupt` 备份可恢复；UI 只表现为「课程列表空了」，原因只出现在服务端 `console.error`（:70-73）。即便重命名成功，数据也只是被静默搬走，UI 无提示。附带：备份实际失败时日志仍打印 `backed up to …`，属日志不实，会误导用户以为数据已保住；备份名固定为 `.corrupt`，二次损坏会互相覆盖。
- **用户可见**: 会（界面表现为课程/设置凭空消失，但不知原因）
- **状态**: 已知报障根因（「数据莫名清空」类症状的机制解释）
- **修复方向**: `load()` 区分 ENOENT 与读取/解析失败（读失败应抛出/拒绝启动并保留原文件）；备份失败时进入只读降级并显式报错、拒绝继续写；备份名带时间戳；日志按实际结果措辞。
- **证据**: 已复现（占住备份路径，Windows 上 `renameSync` 目标为目录即失败）：构造 Store 后 `targets after load: []`、`original file content preserved? false`、store.json 已被空状态覆盖，并打印 `Corrupt store.json — backed up to …\store.json.corrupt. Starting fresh.`。可达性边界：无备份的总丢失需读失败与备份重命名失败同时发生（都在启动瞬间同一把锁下），之后锁释放、下一次写触发 `save()` 才真正覆盖，属「同一时刻双故障 + 稍后一次写」；纯解析失败（手工改坏 JSON）不丢数据，会留下 `.corrupt`（`store.test.ts:108-125` 固化的正是这条正常路径）。降级理由（故取 low）：fallback 是显式注释过的设计决定（:63、:67-69「best-effort backup; if rename fails we still start fresh」），应用自身从不长期持有该文件（写-临时-改名，句柄瞬时），触发窗口窄且有外部性。

### Q33 [low] store 写入无 fsync/原子性保障，进程被强杀或断电可能留下半截文件

- **位置**: `packages/server/src/store/store.ts:84-88`
- **来源**: 审计线 A（A6）附带、E（A8）附带（两份报告均未单列，本次技术主管确认后单列）
- **触发**: `writeFileSync(tmp, ...)` + `renameSync(tmp, file)` 没有 `fsync`，也没有 write-then-fsync-then-rename；进程在写 tmp 期间被 SIGKILL/断电，或 tmp 文件残留。
- **后果**: `store.json.tmp` 可能残留半截 JSON（下次启动不会读它，故影响有限）；极端断电场景下 rename 完成但内容未落盘，会得到损坏文件，进而走 Q32 的损坏分支——与 Q32 形成组合风险。
- **用户可见**: 不会（除极端断电）
- **状态**: 新增
- **修复方向**: 写 tmp 后 `fsyncSync`，rename 后再 fsync 目录；启动时清理残留 `.tmp`。
- **证据**: `save()` 仅 `writeFileSync(tmp, ...)` + `renameSync(tmp, this.file)`，无 fd/fsync 调用；全仓无残留 `.tmp` 清理逻辑。

### Q34 [low] `registerBudget = 0` 是隐式「当天不注册」开关，但前端无约束、无二次确认、文案误导

- **位置**: `packages/web/src/pages/Settings.tsx:19-32,70,102-103,144`；`packages/server/src/api/server.ts:58-68`；`packages/server/src/scheduler/scheduler.ts:174-179`；`packages/server/src/budget/budget.ts:11-13`
- **来源**: 审计线 C（C4）、F（F4）——同一根因，合并
- **触发**: ① 清空「每日查询预算」输入框（受控 `value={value}` 会立刻把 `Number('')===0` 回显成 0）后点保存 → 后端 `min(1)` 拒绝，`api.ts:23` 把整个 zod `flatten()` JSON 拼进 `Error.message`，`Settings.tsx:88` 原样显示在错误栏。② 输入框里只留一个 `-` → `Number('-')===NaN` → `JSON.stringify` 变成 null → 同样 400（React 还会对 `value={NaN}` 报警告）。③ SMTP 端口填 99999/-1/0.5：`emailComplete`（:70）只判真值，三者皆真值 → 前端放行 → 服务端 `emailSchema`（server.ts:50-56）返回 400，界面出现原始 zod JSON。④ 清空「每日注册预算」后保存 → `min(0)` 接受 0。
- **后果**: 边界输入只能靠服务端 400 兜底，且把原始 zod JSON 暴露给用户；`registerBudget=0` 使 `budget.canRegister()`（`registerCount < registerBudget`）当天恒为 false，当天空位全部被跳过。文案 `Daily register budget reached — will retry next cycle`（scheduler.ts:176）在预算从未被用掉时是误导性的。输入框会立刻显示 0、ticker 显示 0/0，所以用户并非完全无信号。schema 侧确实缺 `.int()/.max()`（queryBudget:1.5 会被放行并等效于 2 次）。
- **用户可见**: 会（错误栏出现天书 JSON；预算存成 0 后当天不注册）
- **状态**: 新增
- **修复方向**: 前端在输入层做约束（`min/step`、拒绝空串与 NaN、提交前 clamp）并把 400 转成字段级提示；给 registerBudget 的 0 语义做显式说明或二次确认；补齐 `.int().max(...)`。
- **证据**: `Settings.tsx:25-28` 的 `NumField` 用 `type=number`、`value={value}`、`onChange={(e)=>onChange(Number(e.target.value))}`：空串 → 0，`'-'` → NaN；`server.ts:60-63` 为 `queryBudget: z.number().min(1)`、`registerBudget: z.number().min(0)`，缺 `.int()/.max()`；`api.ts:23` 把 zod `flatten()` JSON 塞进 `Error.message`。修正一处语义误读：`pollIntervalMinutes/queryBudget` 的 min(1) 会返回 400、不静默，真正静默失效的只有注册预算一项。

### Q35 [low] dry-run 演练模式在 Settings 之外没有常驻标识

- **位置**: `packages/web/src/pages/Settings.tsx:122-132`；对照 `packages/server/src/scheduler/scheduler.ts:161-171`
- **来源**: 审计线 F（F5）
- **触发**: 用户为试跑打开「Dry-run（演练）模式」后忘记关闭，继续 Start all 并放任控制台运行数天；期间不去看 Dashboard 控制台。
- **后果**: 命中空位时只记一行日志就返回，永不真正注册/候补，target 永不进入 registered；Shell、Ticker、卡片、徽章均无任何标识（grep dryRun 在 `packages/web/src` 下只命中 `i18n/index.ts` 与 `Settings.tsx`）。用户在长时间不观察控制台的情况下仍可能误判。
- **用户可见**: 会（但状态在 Dashboard 控制台可逐次观察到）
- **状态**: 新增
- **修复方向**: `dryRun` 为真时在 Shell 常驻醒目 banner/徽标，并在开启时二次确认。
- **证据**: 修正原报告一句话：「grep dryRun 只命中 i18n 与 Settings 页 … 与真实抢课表现几乎一致」与代码不符——`scheduler.ts:161-171` 在 dry-run 下每个命中空位的周期都会额外写 `DRY-RUN: would ${action} ${target.targetCrn} — …` 并广播到事件流，紧跟 `scheduler.ts:149` 的 `Opening found` 之后出现在实时控制台。残余缺口是缺少常驻标识，配合开关位置偏僻。

### Q36 [low] `saved ✓` 徽标在保存后不因后续编辑而清除，界面会断言未持久化的状态

- **位置**: `packages/web/src/pages/Settings.tsx:59,85,156`
- **来源**: 审计线 C（C6）附带（原报告未单列，本次确认后单列）
- **触发**: 用户改完预算点保存看到 Saved ✓，随后又改了别的字段但没再点保存。
- **后果**: 徽标仍在，界面在断言一份并未持久化的状态；此时离开页面会在重新挂载时静默丢弃这次编辑（`Settings.tsx:62-66` 的 `!form` 守卫只在首次拿到 data 时写 form）。
- **用户可见**: 会（界面骗人）
- **状态**: 新增
- **修复方向**: 任何表单字段变更时清掉 `saved` 徽标（`setSaved(false)` 放进各 onChange，或在 form 变化时统一重置）。
- **证据**: `saved` 只在 `save()` 成功（:85）与失败（:87）时被写入，onChange 路径不碰它。

### Q37 [low] 提高预算/恢复监控后不会立即重排 `nextPollAt`，用户看不到任何行为变化

- **位置**: `packages/server/src/api/server.ts:136-144`；`packages/server/src/scheduler/scheduler.ts:258-300`；`packages/web/src/pages/Dashboard.tsx:113-116`
- **来源**: 审计线 C（C5）、D（D3）——同一重排缺失，合并
- **触发**: 处于低预算状态（例如剩余 10 次、2 个目标 → `pollsPerTarget=5`，距午夜 600 分钟 → `baseMin=max(30,120)=120` 分钟），此时把每日查询预算从 1000 改成 10000 并保存：`parsed.data` 里没有 cadence 字段变化 → `cadenceChanged=false`，已写入目标里的 `nextPollAt` 不变，最长要等约 2 小时才按新预算重排。同类：预算耗尽时 `scheduleAfterReset` 把 `nextPollAt` 设为「本地午夜 + 1–6 分钟」（:295-300，唯一调用点 :101），用户点 stop-all → start-all（server.ts:198-203）或卡片 Pause → Resume（Dashboard.tsx:75-76 → PATCH + `POST /api/scheduler/start`）时，这些路径都不碰 `nextPollAt`，`pauseAllWatching` 同样不碰；而 tick 只轮到期的目标（:332-334）。
- **后果**: 状态与行为不一致（「看着在跑其实没动」）：卡片长期显示「尚未轮询/上次轮询很久前」，控制台静默；用户改完预算后短时间内观察不到任何行为变化，容易误判「设置没生效」。任何 paused→watching 都保留旧时间戳，故「全部启动」后首轮最长可等一个完整间隔（默认 30 分钟 ± 3）。退避本身会自愈——到本地午夜 `store.getDailyOps` 因日期变更返回归零快照（store.ts:183-189），`canQuery` 恢复，1–6 分钟后正常轮询，故危害是数小时静默而非永久停摆。
- **用户可见**: 会
- **状态**: 新增
- **修复方向**: 把预算字段纳入 `cadenceChanged` 判定（或比较 before/after 的预算差异），预算变化后同样调用 `rescheduleWatching()`；start-all / 单课 Resume 成功后对刚恢复的目标调用 `rescheduleWatching()`（或清空过期的 `nextPollAt`）。
- **证据**: `server.ts:137-144` 的 `cadenceChanged` 只比较 `pollIntervalMinutes/jitterMinutes`，`server.test.ts:341-342` 固化了「改预算不重排」这一现状；`rescheduleWatching()`（:288-292）实现正确，只是触发条件不含预算字段；`ApiScheduler.rescheduleWatching?` 是可选方法（server.ts:29-31 注释说明是给测试替身留的口子），不影响判定。

### Q38 [low] 切换 mode 失败时无 try/catch（未处理 rejection），且忽略 `{started:false}`

- **位置**: `packages/web/src/pages/Dashboard.tsx:45-48,87-98,113-118`；`packages/web/src/lib/api.ts:49`
- **来源**: 审计线 F（F6）
- **触发**: 点卡片 mode 开关而 PATCH 失败（后端刚重启）→ `await api.updateTarget` 无 catch，未处理 rejection，开关由 `target.mode` 驱动而属性未变，视觉上「点了没反应」，用户反复点击；或点「Register now」时该 target 在服务端已不是 watching。
- **后果**: 两种失败都没有任何用户可见反馈（`schedErr` 只覆盖 `onTogglePolling/onToggleScheduler`）；`onRun` 用 finally 清掉 running 却无视响应体，`{started:false, reason:'target is paused'}` 被当作成功，按钮闪一下「… running」即恢复。原报告「用户误以为已强制抢课一轮」的路径需竞态才可达（服务端返回 `{started:false}` 的条件恰是 UI 禁用按钮的条件），真正易触达的是 `onToggleMode` 的未处理 rejection。
- **用户可见**: 会（开关点了没反应）
- **状态**: 新增
- **修复方向**: 两个回调补 `catch → setSchedErr(...)`，并在 `started === false` 时提示 `reason` 后立即 refetch targets。
- **证据**: `Dashboard.tsx:45-48` 无 try/catch；`Dashboard.tsx:87-98` 为 `try { await api.runTarget(id); } finally { … }`，`api.ts:49` 的 `{ started: boolean }` 返回类型被丢弃。对照 `onTogglePolling`（69-85）有完整 try/catch + finally 重拉，可见是遗漏而非设计。

### Q39 [low] 设置数值项无范围校验的 schema 卫生问题与自动轮询节奏的展示失真

- **位置**: `packages/server/src/api/server.ts:58-68`；`packages/web/src/components/Ticker.tsx:31-36`；`packages/server/src/scheduler/scheduler.ts:268-283`
- **来源**: 审计线 C（C4）、C（C5）附带观察（原报告列为附带项，本次合并为一条低优先级观感/校验卫生问题）
- **触发**: `settingsSchema` 缺 `.int()`/`.max()`，`queryBudget: 1.5` 会被放行并等效于 2 次；ticker 展示的是配置间隔 `s?.pollIntervalMinutes`，而真正生效的是被预算拉伸后的间隔。
- **后果**: 校验卫生缺口（不成灾）；用户看到的「间隔 30 ± 3 分钟」与实际生效间隔可能相差数倍，配合 Q24 造成「设置没生效」的误判。
- **用户可见**: 会（间隔数字与实际不符）
- **状态**: 新增
- **修复方向**: 补齐 `.int()` 与合理 `.max()`；ticker 展示「有效间隔」或「下次轮询时间」（`nextPollAt` 已随 `/api/targets` 下发）。
- **证据**: `server.ts:60-63` 仅 `z.number().min(...)`；`grep nextPollAt` 在 `packages/web` 下 0 命中（`shared/src/store-types.ts:22` 已定义、`scheduler.ts:282` 已写入）；`fmtCountdown` 有实现有测试但无任何 UI 调用点。

### Q40 [low] 重启后 `error`/`registered` 等终态无任何提示，用户只能看到「一排暂停卡片 + 空日志」

- **位置**: `packages/web/src/pages/Dashboard.tsx:125-133,148-164`；`packages/server/src/api/server.ts:196-210`
- **来源**: 审计线 B（A7）、D（D2）
- **触发 / 后果 / 证据**: 与 Q11 同一现象的另一半——即便启动归一化写了事件，`error`/`registered`/`waitlisted`/`stopped` 目标在 UI 上也只是静态徽章，重启后用户无法从界面区分「我手动暂停的」与「被重启停掉的」与「因错误停掉的」。
- **用户可见**: 会
- **状态**: 已知报障根因
- **修复方向**: 卡片补一行「状态变更来源/时间」（`lastPolledAt` 已有位），或在控制台给出重启摘要事件（与 Q11 同一改动）。
- **证据**: `StatusBadge` 仅按 status 渲染徽章；`WatchTarget` 无「最后一次状态变更原因」字段。

### Q41 [low] 启动阶段没有任何「引擎已启动/未启动」的可见状态，`GET /api/scheduler` 拉了却不渲染

- **位置**: `packages/web/src/lib/DataContext.tsx:22`；`packages/web/src/pages/Dashboard.tsx:81,112-116`；`packages/web/src/App.tsx:36-45`
- **来源**: 审计线 D（A5）
- **触发**: `scheduler` 资源在 `DataContext.tsx:22` 与 `Dashboard.tsx:81` 被拉取/重新拉取，但全 web 无任何组件渲染 `scheduler.data.running`（grep 只有 refetch 用法）；`start()` 只 `setInterval` 不立即 tick（scheduler.ts:309-318），点击「全部启动」后 0–30 秒内没有任何新日志（`start()`/`start-all`/`updateTarget` 都不写事件），页面唯一反馈是按钮标签互换；`nextPollAt` 由 `scheduleNext/scheduleAfterReset` 写入（:282,:298）却在 `packages/web` 内零引用，卡片只显示 `lastPolledAt`（CourseCard.tsx:72-74）。
- **后果**: 用户无法区分「已启动/未启动」；新建目标首次轮询最迟 30 秒内发生（`(t.nextPollAt ?? 0) <= now` 视为到期），但被恢复的目标可能长达一整个轮询间隔甚至数小时（见 Q37）。
- **用户可见**: 会（点完开始后彻底静默，只能靠猜）
- **状态**: 新增
- **修复方向**: 把 `GET /api/scheduler` 的 running 真正显示出来；`start()` 装好定时器后立即 `void this.tick()`；卡片展示 `nextPollAt`（「已排队，预计 HH:MM」）。
- **证据**: `grep nextPollAt` 在 packages/web 下 0 命中；`scheduler` 资源无渲染消费者；`start()`（:309-318）只 `setInterval`。

### Q42 [low] 一键执行失败/`started:false` 无反馈（与 Q38 共用修复）

- **位置**: `packages/web/src/pages/Dashboard.tsx:87-98`；`packages/server/src/api/server.ts:115-125`
- **来源**: 审计线 F（F6）、D（A6）
- **触发 / 后果 / 修复方向**: 见 Q38 与 Q19 的 `/run` 返回值部分。
- **用户可见**: 会
- **状态**: 新增

### Q43 [low] 停止后 0–30 秒静默无事件，用户以为「没生效」而重复点击

- **位置**: `packages/server/src/scheduler/scheduler.ts:308-323`；`packages/server/src/api/server.ts:188-210`
- **来源**: 审计线 D（A5）
- **触发**: start/stop/start-all/stop-all 四个端点都不写事件（server.ts:188-210 只改状态并返回 JSON）；`start()` 不立即 tick。
- **后果**: 用户唯一的反馈是按钮标签互换与 Ticker 的 watching 计数；若此时再点一次主按钮，`anyWatching` 已为 true → 走 stop-all（与 Q8 合流），把刚启动的引擎与课程又停掉。
- **用户可见**: 会
- **状态**: 新增
- **修复方向**: 这四个端点各写一条 info/action 事件（「Engine started」「Paused N courses」），并在 `start()` 后立即 tick（同 Q41）。
- **证据**: `server.ts:188-210` 无 `appendEvent` 调用；`start()` 只装定时器。

### Q44 [low] 控制台/上下文对「已注册/已候补」等关键结果的呈现依赖用户停留页面

- **位置**: `packages/web/src/pages/Dashboard.tsx:14,38-43`；`packages/web/src/lib/useEventStream.ts:28-31,47-52,56-60`
- **来源**: 审计线 F（F3）
- **触发**: 切到 Courses/Session/Settings 页停留；或停在 Dashboard 但发生不产生事件的状态变化（本地午夜预算重置——`scheduleAfterReset` 只重排 `nextPollAt`，`store.getDailyOps` 的跨日归零是纯读路径 `budget.ts:23-30`，不发事件；另一标签页改了设置）。
- **后果**: `Dashboard.tsx:14` 的 `useEventStream()` 是全仓唯一调用点，卸载即 `ws.close()`，因此切到其他路由后全应用再无任何事件与轮询更新，Ticker 的 watching/今日查询/今日注册/会话点全部冻结；调度器因会话失效把 target 置为 paused（scheduler.ts:105-108）时，若用户不在 Dashboard，卡片会一直显示 WATCHING，直到用户碰巧回到 Dashboard 触发一次 refetch。
- **用户可见**: 会（UI 冻结在旧状态）
- **状态**: 新增
- **修复方向**: 把 `useEventStream` 提升到 DataProvider/Shell 层保活（顺带解决 Ticker 掉线灰点的设计缺口），并在 Dashboard 的 refetch 里补上 `sessionRef.current.refetch()`。
- **证据**: 修正原报告一处：`server.ts:235-246` 每次 WS 建连立即 `socket.send({type:'recent'})`，`useEventStream.ts:40` 用快照替换数组，使 `Dashboard.tsx:38` 的 `lastEventId` 变化并触发 :39-43 的 refetch，故 **Dashboard 挂载时**重连等价于自动重拉 targets+budget；真实缺口收敛为非 Dashboard 路由与 session 资源。`Ticker.tsx:4-13` 无 connected prop（掉线灰点未实现）。

### Q45 [low] 语言切换后 `<html lang>` 仍是 en，语言控件当前项未暴露给辅助技术

- **位置**: `packages/web/index.html:2`；`packages/web/src/i18n/index.ts:222-229`；`packages/web/src/components/LanguageSwitcher.tsx:14,19`
- **来源**: 审计线 F（F8）
- **触发**: 顶部切换语言为中文/FR 后用读屏软件阅读页面，或触发浏览器翻译/断词。
- **后果**: 文档语言始终声明为英语，读屏用英文语音规则读中文/法文；当前语言仅由 CSS class `pill-on` 表示（LanguageSwitcher.tsx:19），无 `aria-pressed`/`aria-current`，容器标签还是硬编码英文 `aria-label="language"`（:14）。
- **用户可见**: 会（仅对读屏/翻译场景）
- **状态**: 新增
- **修复方向**: 在 `setLang`/`languageChanged` 中同步 `document.documentElement.lang = lng`；语言按钮加 `aria-pressed`，容器标签走 i18n。
- **证据**: `index.html:2` 为静态 `<html lang="en">`；`i18n/index.ts:222-229` 的 `setLang` 只做 `changeLanguage` + localStorage；全仓无 `documentElement.lang` 写入点。

### Q46 [low] 实时控制台无 aria-live，新日志与「已注册」等关键行对读屏用户静默

- **位置**: `packages/web/src/components/Console.tsx:41,50-56`
- **来源**: 审计线 F（F9）
- **触发**: 用读屏软件停在页面等待自动化结果（候补成功/注册成功/报错）。
- **后果**: 日志容器只是普通 `div.log`，无 `role="log"`/`aria-live`，新到的 ok/error 行不播报；反而连接状态行有 `role="status"`（:41），用户能听到「重连中…」却听不到「Registered COMP 551!」。
- **用户可见**: 会（仅读屏用户）
- **状态**: 新增
- **修复方向**: 给日志容器加 `role="log"` + `aria-live="polite"`（错误可 `assertive`），必要时 `aria-relevant="additions"`。
- **证据**: `Console.tsx:50-52` 无任何 ARIA live 属性；`:41` 的 `role="status"` 与之形成鲜明对比。

### Q47 [low] 关键路径测试缺口：重连退避、App 壳预算换算、初始加载失败、`nextPollAt` 展示均无测试

- **位置**: `packages/web/src/lib/useEventStream.test.tsx:58-64`；`packages/web/src/App.tsx:40-42`；`packages/web/src/pages/Dashboard.test.tsx:8-14,16-25`；`packages/server/src/api/server.test.ts:121-124,341-342`
- **来源**: 审计线 F（F10）
- **触发**: 任何一次改动后的 `npm run test` 全绿；这些路径从未被验证。
- **后果**: 逐条复核结论：1) 属实——设计 §7 要求验证「快照→增量、重连退避」，但测试只断言 `onclose` 后 `connected=false`；退避 `setTimeout`（useEventStream.ts:50-51）、重连后 recent 重播种、卸载 `clearTimeout`（:56-60）全无覆盖，FakeWS 连 `onerror` 都没有，`:43-46` 的 CSP 分支从未执行。2) 属实——`packages/web/src` 下无 `App.test.tsx`，`App.tsx:40-43` 的预算换算与 100/20 默认值无断言；`Ticker.test.tsx:8-17` 只喂字面量 props。3) 属实——无任何用例让 `getTargets/getSettings` reject（各页测试的 `mockAll()` 全部 `mockResolvedValue`），因此 Q13 的「错误被吞成空态/永久加载中」不会被发现；附带发现：`Dashboard.test.tsx:16-25` 的 `mockApi` 未 mock `getSettings/getScheduler`，而 DataProvider 会拉这两个端点，于是测试里真实 fetch 被调用并 reject（仅因 `useResource` 内部 catch 才没炸掉用例），说明该测试套件对加载失败路径是「瞎」的。4) 属实——`fmtCountdown` 有完整测试（`format.test.ts:10-13`）却无 UI 调用点。
- **用户可见**: 不会（属回归防线缺口）
- **状态**: 新增
- **修复方向**: 补三类用例：fake timers 推进重连退避并断言第二次 `new WebSocket`；新建 `App.test.tsx` 覆盖 Ticker 数值与失败回退；各页补「初次加载 reject → 错误条 + 可重试」用例；把 Q29 的空跑用例改成先 seed 数据。
- **证据**: `Dashboard.test.tsx:8-14` 的 `vi.mock('../lib/useEventStream')` 使真实退避/重播种逻辑在页面测试中也被整体旁路；`server.test.ts:121-124` 无 seed、`beforeEach(:27-30)` 每次新建空 Store，`[]` 恒成立。

---

## P3 — 记录待办

以下 13 条经核对成立但本批次不建议动手（要么设计上是有意为之、要么触发窗口窄、要么纯记录/说明性质）。**编号保留，便于后续引用。**

### Q48 [medium] 大量硬编码/魔法值与宿主环境耦合（时区、端口、profile 路径、超时）

- **位置**: `packages/server/src/scheduler/scheduler.ts:296,302-306`；`packages/server/src/api/main.ts:5,15`；`packages/server/src/session/config.ts`
- **来源**: 审计线 A、B、D、E 的附带观察（原报告未单列，本次合并记录）
- **触发 / 后果**: 本地午夜按宿主时区计算、端口/profile 路径/超时全部硬编码或仅靠环境变量，跨时区/多实例/测试隔离时容易出错。
- **用户可见**: 不会
- **状态**: 新增
- **修复方向**: 把时区、端口、超时收敛到一处配置并写入文档；暂不改行为。
- **证据**: `msUntilLocalMidnight` 直接用 `new Date()` 本地时区；`PORT` 从环境变量取但无校验。

### Q49 [medium] dry-run 与 notify 模式缺少端到端断言，模式语义只由单测的零散用例保证

- **位置**: `packages/server/src/scheduler/scheduler.ts:154-171`；`packages/server/src/scheduler/scheduler.test.ts`
- **来源**: 审计线 D、F 的附带观察
- **触发 / 后果**: notify 与 dry-run 两条提前返回路径决定了「不会真注册」，但缺少覆盖两者与预算拉伸（Q24）交互的用例。
- **用户可见**: 不会
- **状态**: 新增
- **修复方向**: 补「notify/dry-run 下不消耗注册预算」「×3 不作用于 notify/dry-run」的回归用例（与 Q24 的修复同批）。
- **证据**: 现有用例覆盖 `runOnce` 的主路径与 in-flight 守卫，未覆盖 mode × budget 组合。

### Q50 [medium] 文档（design/plan/README）与实际实现存在偏差，需一次性校准

- **位置**: `docs/superpowers/specs/2026-06-01-autoregister-design.md:94,99`；`docs/superpowers/plans/2026-06-02-p5a-store-scheduler.md:170`；`docs/superpowers/plans/2026-06-02-p7b-web-pages.md:579-588`；`docs/superpowers/plans/2026-06-01-p4-register.md:193-197`；`README.zh.md:136-139`
- **来源**: 审计线 B、C、D
- **触发 / 后果**: 三处文档描述的语义与实现相反或过时（失败后回到 watching、主开关由引擎状态驱动、注册提交后等待结果页），是 Q3/Q4/Q8 的设计层根因来源，也是后续开发再次踩坑的地图。
- **用户可见**: 不会
- **状态**: 已知报障根因（文档层）
- **修复方向**: 修完 Q3/Q4/Q8 后同步更新这些文档段落，避免下次按旧计划实现。
- **证据**: 见 Q3、Q4、Q8 的证据段。

### Q51 [low] 卡片「上次轮询」的相对时间是硬编码英文（i18n 残留）

- **位置**: `packages/web/src/lib/format.ts:19-25`；`packages/web/src/components/CourseCard.tsx:73`
- **来源**: 审计线 F（F7）
- **触发**: 切到中文或法文后查看任意课程卡片底部的「上次轮询」。
- **后果**: 得到混排文案「上次轮询 5m ago」「dernier sondage 2h ago」。
- **用户可见**: 会（仅观感）
- **状态**: 新增
- **修复方向**: 让 `fmtRelative` 返回结构化的 `{unit,value}`，或把 justNow/Minutes/Hours 词条交给 i18next 插值。
- **证据**: `format.ts:21-25` 直接返回 `'just now'` / `${s}s ago` / `${m}m ago` / `${h}h ago`；用正则扫描 `packages/web/src` 全部非测试 `.tsx/.ts` 后确认这是三语字典中唯一未被 `t()/tr()` 包裹的用户可见文案。

### Q52 [low] 未处理的 rejection 在 store 写路径（`writeFileSync`）同样无保护

- **位置**: `packages/server/src/store/store.ts:84-88`；`packages/server/src/scheduler/scheduler.ts:139,153`
- **来源**: 审计线 E（A1）附带
- **触发**: 磁盘满/杀软占用/权限错误导致 `save()` 抛错，而调用方（`updateTarget`/`appendEvent`）在 scheduler 的关键路径中同步抛出。
- **后果**: 与 Q1 同一路径杀死进程（Q1 的修复若只加定时器 catch，仍需注意这里的同步抛出会以 rejection 形式冒泡）。
- **用户可见**: 会（同 Q1）
- **状态**: 已知报障根因（Q1 的扩展面）
- **修复方向**: 在 `save()` 内捕获并降级为 error 事件（或让 scheduler 的调用点统一包 try/catch），与 Q1 同批。
- **证据**: `scheduler.ts:139` 的 `store.updateTarget(...)` 与 `:153` 附近的事件写入都在周期内同步执行，无 try/catch。

### Q53 [low] `log()`（`appendEvent`）自身失败会把「记日志」变成「崩溃源」

- **位置**: `packages/server/src/scheduler/scheduler.ts:71-74,82,100`；`packages/server/src/store/store.ts:147-155`
- **来源**: 审计线 A、E 的附带观察
- **触发**: 事件写入失败时，`this.log(...)` 会在 catch 块内再次抛出，把「记录错误」变成新的崩溃点。
- **后果**: 与 Q1/Q52 合并放大；例如 in-flight 命中的 info 日志失败会直接击穿 `runOnce`。
- **用户可见**: 会（同 Q1）
- **状态**: 新增
- **修复方向**: `log()` 内部 try/catch 并回落到 `console.error`，保证日志失败永不影响主流程。
- **证据**: `scheduler.ts:71-74` 的 `log()` 无任何保护，且在 :82/:100 等 catch/early-return 路径中被调用。

### Q54 [low] 注册流程的 `humanPause()` 次数与时长偏多，单周期 30-60s 放大了所有竞态窗口

- **位置**: `packages/server/src/minerva/query-client.ts:24-63`；`packages/server/src/minerva/register-client.ts:17-70`；`packages/server/src/util/pacing.ts`
- **来源**: 审计线 A、B（Q2/Q9/Q25 的共同放大因子，原报告未单列）
- **触发 / 后果**: 查询 6 处、注册 4 处 `humanPause()`（默认 3s±1s），使「状态检查 → 执行」窗口天然长达数十秒，Q2/Q9/Q25 的竞态因此在实践中很容易撞上；同时拉长单周期，与 Q23 的手动触发叠加时更易重复导航。
- **用户可见**: 不会（但决定了几条竞态的可达性）
- **状态**: 新增
- **修复方向**: 保持 pacing 意图不变（这是防封号设计），仅在关键决策点补状态复检/取消令牌，不要下调停顿。
- **证据**: `query-client.ts` 的 9 处 `humanPause()` 与 `register-client.ts` 的 4 处；Q2/Q9 的可达性分析均以这些时长为基准。

### Q55 [low] 运行中新增课程会与已存在的 watching 目标叠加触发主开关陷阱

- **位置**: `packages/web/src/pages/Courses.tsx:29-37`；`packages/server/src/store/store.ts:107-112`
- **来源**: 审计线 D（A1/A4）附带
- **触发 / 后果**: 前端 body 不含 status，`addTarget` 默认写 watching，使「运行中加课」成为 Q8/Q12 陷阱的必然触发点；`addTarget` 也不去重（store.ts:99-116、server.ts:95-99），重复提交会产生重复目标。
- **用户可见**: 会
- **状态**: 已知报障根因
- **修复方向**: 与 Q8 同批（让新目标默认 paused，或在 UI 明确询问是否立即监控）；顺带在 `addTarget` 加「同 term+CRN 已存在」的判重。
- **证据**: `Courses.tsx:29-37` 的 body 不含 status；`store.ts:111` 的 `status: input.status ?? 'watching'`。

### Q56 [low] 预算耗尽/午夜重置的时钟语义只写进 pid 内状态，跨日边界无测试

- **位置**: `packages/server/src/store/store.ts:183-195`；`packages/server/src/scheduler/scheduler.ts:99-103,294-306`
- **来源**: 审计线 A、C
- **触发 / 后果**: `getDailyOps` 的跨日归零是纯读路径（不落盘、不发事件），配合 Q24/Q37 造成「午夜后新鲜预算空转」；无跨日边界测试。
- **用户可见**: 不会（间接影响见 Q37）
- **状态**: 新增
- **修复方向**: 补一个用注入时钟跨过本地午夜的调度用例；确认 `ensureRollover` 与只读快照的一致性。
- **证据**: `budget.ts:23-30` 与 `store.ts:183-189` 为纯读；`ensureRollover` 只在 increment 时调用。

### Q57 [low] 审计范围外但与 Q1 同源的进程健壮性缺口：无 SIGINT/SIGTERM 与退出钩子

- **位置**: `packages/server/src/api/main.ts:7-22`
- **来源**: 审计线 B（A6）附带
- **触发 / 后果**: API 进程无 SIGINT/SIGTERM 处理（`closeSession` 仅被三个 CLI 脚本使用），Ctrl+C 时浏览器上下文是否干净关闭取决于 Playwright 默认行为；异常退出时可能留下 profile 锁，下次 `launchPersistentContext` 更易失败。
- **用户可见**: 不会（间接表现为下次登录失败）
- **状态**: 新增
- **修复方向**: 注册 SIGINT/SIGTERM 钩子优雅关闭 `SessionManager`；与 Q15 同批（登录失败可见性）。
- **证据**: grep 确认 `closeSession` 仅 `register-script.ts:40`、`query-script.ts:36`、`login-script.ts:21` 使用，API 进程无退出钩子。原报告「孤儿 Chromium 占用 profile」的因果链已被实测证伪（子进程随父进程终止），故仅保留「无退出钩子」这一实现缺口。

### Q58 [low] store 的 `.corrupt` 备份固定文件名 + 失败日志不实，二次损坏会互相覆盖

- **位置**: `packages/server/src/store/store.ts:64-73`
- **来源**: 审计线 E（A8）附带、A（A6）附带
- **触发 / 后果**: 备份名固定为 `${file}.corrupt`，二次损坏覆盖上一次备份；备份失败时日志仍打印 `backed up to …`，误导用户以为数据已保住。
- **用户可见**: 不会（属事后取证能力）
- **状态**: 新增
- **修复方向**: 备份名带时间戳；日志按实际结果措辞（并入 Q32 同一改动）。
- **证据**: `store.ts:64-73`：`const corruptPath = \`${this.file}.corrupt\`` 固定；catch 块空，但 `console.error` 无条件宣称已备份。

### Q59 [low] `runCycle` 的失败路径不消耗注册预算但计入失败 streak（计数口径说明）

- **位置**: `packages/server/src/scheduler/scheduler.ts:122-127,41-48`
- **来源**: 审计线 D（A11）
- **触发 / 后果**: `checkCourse` 抛错时，代码先 `budget.recordQuery(now)` 再 `noteFailure`（:122-127）：查询预算被消耗但注册预算不受影响，失败计数（FAILURE_LIMIT streak）与注册预算相互独立，只是计数口径说明，不造成预算泄漏。
- **用户可见**: 不会
- **状态**: 已存在于计划（行为一致、无需修改）
- **修复方向**: 无需修改；在文档/注释中说明失败计数与预算互不影响即可。
- **证据**: 行号已核对，语义与报告一致。

### Q60 [low] `POST /api/targets/:id/run` 的 `started:true` 无法区分「排队/丢弃/立即执行」，属契约表达力不足

- **位置**: `packages/server/src/api/server.ts:111-125`；`packages/web/src/lib/api.ts:49`
- **来源**: 审计线 D（A6）、F（F6）
- **触发 / 后果**: 无论被 in-flight 丢弃还是被接受都返回 `{started:true}`，调用方无法据此提示用户（Q16/Q38 的接口层根因）。
- **用户可见**: 不会（间接见 Q16）
- **状态**: 新增
- **修复方向**: 与 Q16 同批扩展返回值为 `{started, reason?, queued?}`。
- **证据**: `server.ts:123-124` 无条件 `return { started: true }`；`api.ts:49` 的类型只有 `{ started: boolean }`。
