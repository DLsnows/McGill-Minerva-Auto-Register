# B 会话与 Minerva 自动化（对抗性验证后）

## 摘要

对被审报告 6 条发现逐条独立复核（打开原文件与行号、核对上游守卫、并针对两条 Playwright 语义断言做了**真实 Chromium 复现实验**）后的结论：**2 条 confirmed、4 条 downgraded、0 条整体证伪**。两个 high 都站得住，其中"注册提交后解析半读文档"这一条被实验坐实（`waitForLoadState` 实测 1–3ms 返回，`page.content()` 拿到 58 字符的半截文档，仓库自带解析器对这份 HTML 返回 `not-found`），并且其最严重后果比原报告写的更硬：成功注册后的重复提交会落到 `Registration Errors` 分支，被解析为 `error`，三次后目标被置为 `error` 并永久停止监控。四条 medium 的**机制与行号全部正确**，但严重度普遍被高估：它们要么依赖无法验证的外部页面文案，要么依赖用户手动点击与后台周期重叠的时序，要么有原报告未察觉的上游保护（8 秒 `waitForSelector`、逐目标 `inFlight`、`await` 串行 tick）。原报告在发现 6 中夹带的一个子论断被**证伪**（孤儿 Chromium 占用 profile 导致后续 launch 更易失败——实测子进程随父进程退出而终止，且 API 进程从未启动浏览器时首次 tick 会先按发现 1 崩掉）。

## 发现

### [high] 调度器 tick 路径未捕获会话探测异常，网络抖动或用户关闭浏览器窗口会以 unhandled rejection 杀死整个 API 进程

- **位置**: packages/server/src/scheduler/scheduler.ts:314（触发点）；异常抛出点集中在 packages/server/src/session/session-manager.ts:41（`getPage()` → `requireContext()` 抛错）与 58（`goto` 导航超时/页面已关闭）
- **触发路径**: 任一课程处于 watching 且调度器已启动。之后发生下列任一情况，下一次 tick 即终止进程：(1) 用户关掉 Minerva 浏览器窗口 → `context.on('close')` 把 `this.context` 置空（session-manager.ts:29-31），下一次 `isLoggedIn()` → `getPage()` → `requireContext()` 抛 `SessionManager not launched — call launch() first`；(2) 页面/Chromium 崩溃 → `goto` 在 `_setupNavigationWaiter` 里对 `Page.Close`/`Page.Crash` 注册了立即 reject（playwright-core 1.60 coreBundle.js:55491-55496），抛 Target-closed / "Navigation failed because page crashed!"；(3) Minerva 不可达 → `goto` 未传 timeout，走默认导航超时后抛 `Timeout 30000ms exceeded.`。
- **后果**: `tick()` 的 rejection 无人处理，Node 22/24 默认终止进程 —— 服务端直接死掉，WS 断开，日志停止。store 中目标仍是 `watching`，重启后 packages/server/src/api/main.ts:12 的 `pauseAllWatching()` 把它们改回 `paused`，监控在用户不知情下彻底停止。`tick()` 的 for 循环也没有 try/catch（scheduler.ts:335-337），一个目标抛错会跳过本轮其余到期目标。
- **验证方式**:
  - 行号与代码逐字相符：scheduler.ts:311-317 的 `void this.tick().finally(...)` 确实没有任何 `.catch()`；`.finally()` 返回的新 promise 会以同一原因 reject，因此原 rejection 被转嫁给一个无人持有的 promise（这正是"无人处理"的确切来源）。
  - `runCycle` 中 `if (!(await this.deps.session.isLoggedIn()))`（scheduler.ts:105）是 105–193 全段唯一未被 try/catch 包住的 await：120-127 的 `checkCourse`、182-189 的 `act` 都有；`budget.canQuery` 是同步的。**上游守卫确认不存在**。
  - 全仓库 grep `unhandledRejection|uncaughtException|process.on(` 在 packages/ 下**零匹配**，主入口只有 `main().catch()`（仅覆盖启动阶段）。
  - **实测复现**：以等价结构（`setInterval` + `void tick().finally(...)` + 一个必然 reject 的 await）运行 `node v24.5.0`（engines 要求 `>=22`）：进程以 exit code 1 终止并打印该 Error，未走到 400ms 后的存活分支。而 `runTarget()`（scheduler.ts:219-223）对同类错误是 `.catch()` 兜住的 —— 证实这是遗漏而非有意设计。
- **对原报告的两处修正**: (1) 原报告称关窗后 `getPage()` 抛 `SessionManager not launched`，但 `loadCycle` 在 `runCycle` 早期已调用 `getPage()`（query-client.ts:21 / register-client.ts:39）并成功返回了 Page 对象，随后在已关闭的 Page 上调用 `goto` 时才抛错，实际错误更可能是 Target-closed 类；(2) 原报告把 `checkStatus()` 的 `goto` 列为无 timeout，这一点属实（coreBundle.js:55476-55482 会填入默认导航超时），但没有区分"默认 30s 超时"与"永久挂起"——是前者，所以崩溃会稳定发生在约 30 秒后的下一次 tick。
- **最终判定**: **confirmed / high**
- **建议**: 在 `start()` 的定时回调统一 `.catch()`（或给 runCycle 的会话探测加 try/catch → 记 error 事件并跳过该目标），`main.ts` 注册 `unhandledRejection`/`uncaughtException` 兜底，并给 `checkStatus` 的 `goto` 设显式 timeout。

### [high] 注册提交后不等结果页加载就解析内容，成功注册可能被读成 not-found 或抛错

- **位置**: packages/server/src/minerva/register-client.ts:48-52（同样问题见 67-72）
- **触发路径**: auto 模式命中空位自动提交，或手工 `register --confirm`。提交后结果页（bwckcoms.P_Regs）由 Banner 现渲染；`waitForLoadState('domcontentloaded')` 与该 document 早已触发过的 DCL 是同一个生命周期事件，**不能**为紧随其后的 `page.content()` 提供任何等待。
- **后果**: `parseRegisterResult(await page.content(), crn)` 读到**尚未接收完的 HTML** → 表里没有该 CRN → `not-found` → `applyOutcome` 视为"无事发生"并 `scheduleNext`（scheduler.ts:238-244）：真实成功的注册既无 `registered` 状态、也无成功日志与通知，下一轮会再次提交同一 CRN；若 `page.content()` 撞上导航则抛 `Unable to retrieve content because the page is navigating and changing the content.`，被 scheduler.ts:184-188 记成 `Registration attempt threw`。二者都会让 auto 模式重复提交已注册的 CRN；此时 `parseRegisterResult` 读到的是 **Registration Errors** 表，该表里找不到匹配 CRN 时最终落到 `{ kind: 'error' }`（parse-register-result.ts:50-71、77），于是 `noteFailure` 连错 3 次把目标置为 `error` 并永久停止监控 —— 明明已经注册成功。
- **验证方式（实测复现，而非纸面推断）**: 用仓库内安装的 playwright-core 1.60 + 本机 `ms-playwright/chromium-1217` 真实 Chromium，逐字复刻 register-client.ts:48-52 的代码序列，起一个本地服务端在 POST 后先 commit、再延迟若干毫秒才写完响应体：
  - `delayMs=0` → `waitForLoadState` 用 1ms 返回，`content()` 拿到完整文档，含 Current Schedule 表（对照组，说明并非必然失败）。
  - `delayMs=50/200/500/1500` → `waitForLoadState` 分别只用 1/1/1/3ms 返回（**证实其为空操作**），`content()` 拿到 58 字符的半截文档 `"<html><head></head><body><h1>processing</h1></body></html>"`，`sawCurrentScheduleTable: false`。
  - 把该 HTML 喂给仓库自带解析器（`node --experimental-strip-types` 直接 import 源码）：`parseRegisterResult(partial, '1814')` → `{"kind":"not-found","crn":"1814"}`。**原报告的因果链被完整坐实。**
  - 抛错路径同样实测：在一次进行中的导航期间调用 `page.content()` → `page.content: Unable to retrieve content because the page is navigating and changing the content.`（与 coreBundle.js:17806-17824 的实现一致）。
  - 源码佐证（行号经核对，原报告引用准确）：`Frame.waitForLoadState` 在 `_firedLifecycleEvents` 已含该事件时直接返回（coreBundle.js:17655-17659），而 `click` 只等到信号屏障与"可能触发的导航"提交（17197-17211），`_onClearLifecycle` 在**新 document 提交时**才清空生命周期集合、随后重新触发 commit/DCL（17480-17490）——因此 DCL 是否已重新触发完全取决于响应体到达的速度，正是实验观测到的两种结果。
  - 对比项也成立：query-client.ts:67 确实有 `waitForSelector('table.datadisplaytable', { timeout: 8000 })` 作为兜底，注册路径没有。
- **对原报告的一处加强**: 原报告把"重复提交"写成了"下一轮还会再次提交同一 CRN"，方向正确但把后果说轻了。Banner 对已注册课程的重复提交会进入 Registration Errors 分支并被解析成 `error`，因此后果不只是"没有成功通知"，而是**目标被置为 error 并永久停止监控**。另外注意 packages/web 前端从不调用 register-client，因此这不是前端可达性问题，而是 auto 模式与 CLI 的必经路径。
- **设计意图核对**: docs/superpowers/plans/2026-06-01-p4-register.md:193-197 就写着这个 `Promise.all([waitForLoadState, click])` + 立即 `content()` 的片段，说明它是按计划实现的、并非实现走样；但计划文档只规定用 `waitForLoadState` 而没意识到它与前置 `goto(..., domcontentloaded)` 共用同一事件，属计划本身的缺陷。
- **最终判定**: **confirmed / high**
- **建议**: 提交后等待结果页锚点（如 `page.waitForSelector('table[summary="Current Schedule"], table[summary*="Registration Errors"]')` 或 `waitForURL`/`waitForNavigation` 后再解析），并让 `content()` 失败/解析失败不要退化成 `not-found`；对 `not-found` 至少不要触发"再次提交"的循环。

### [medium] 同一个 page 被调度器轮询与手工 Register now 并发驱动，没有互斥锁

- **位置**: packages/server/src/scheduler/scheduler.ts:219-223、81-91；packages/server/src/session/session-manager.ts:40-44
- **触发路径**: 调度器运行中（多门 watching 课程），在后台 tick 正轮询课程 B 时点击课程 A 的 "Register now"。UI 不拦：CourseCard.tsx:63 的 `running` 只是**该目标自身**的一次 HTTP 往返标志（Dashboard.tsx:87-98 的 `setRunning`），而 `POST /api/targets/:id/run` 只校验 `target.status === 'watching'`（api/server.ts:115-125）便转交 `runTarget`。
- **后果**: 两条多步导航流程交替操作同一个共享 page，一方的 `goto` 打断另一方页面状态：`selectOption`/`fill` 等到错误页面并 30s 超时 → 查询失败 → 失败连击 → 目标变 error。最坏情况两者都进入提交阶段：`Submit Changes` 提交的可能是另一目标的 CRN，而结果按各自 CRN 解析，真实注册被记成 not-found，归属错乱且无成功通知。
- **验证方式**: 机制与行号全部核实成立 —— 全仓库 grep `mutex|lock|queue|semaphore|serial` 在 packages/ 下**零命中**（唯一匹配是 UI 文案）；`inFlight` 是 `Set<string>` 且只在 `runOnce` 里按 targetId 增删（scheduler.ts:81-90），确实管不住"另一个目标 + 同一 page"；`getPage()`（session-manager.ts:40-44）确实把同一个 Page 发给所有调用者，且 `QueryClient`/`RegisterClient` 各自都只持有 `SessionManager`。UI 侧 `await api.runTarget(id)` 在服务端立即返回 `{started:true}`（api/server.ts:123-124），`setRunning` 随即被清除，连"点击期间禁用"都只有一瞬。
- **对原报告的一处修正（双向）**: 原报告的场景需要用户恰好在别的目标周期内点击。考虑到 `humanPause()` 默认 3s±1s、查询流程有 6 处（query-client.ts:24/26/28/35/37/44/47/57/59），单次查询光人为停顿就 ≥18s、加上导航与解析通常 20-25s，注册流程同样有 4 处停顿加表单提交，**重叠窗口远大于"瞬时点击"**，因此可达性比原报告描述的要高；但另一方面，受影响的是单个用户自己的会话，最坏结果是状态归属错乱并可在日志中发现，并未达到"进程崩溃/数据损坏"的量级。
- **最终判定**: **downgraded / medium**（维持原严重度，但下调确信度表述：不是"必然发生"，而是"窗口足够宽、需要用户手动点击触发"）
- **建议**: 在 SessionManager 上加全局串行队列/互斥锁，所有浏览器操作（含登录流程与 `isLoggedIn` 探测）排队；`runTarget` 在已有 cycle 运行时改为排队而非并发。

### [low] 解析失败与"CRN 未找到"不可区分，一次慢页面或一次表头变动即可让目标被永久停止

- **位置**: packages/server/src/minerva/query-client.ts:65-68、packages/server/src/minerva/parse-sections.ts:16,42、packages/server/src/scheduler/scheduler.ts:130-137
- **触发路径**: Minerva 结果表 caption 文案变化，或 WL Cap/WL Act/WL Rem 任一列缺失/改名，导致 7 列没认全。
- **后果**: `parseSections` 在"没有 Sections Found 表"和"表头 7 列没认全"两种情况下都返回 `[]`，`checkCourse` 因而返回 `null`；scheduler.ts:130-137 把 null 一律当成**失败**并给出 `CRN ... not found ... — check the CRN, term, subject, course number and faculty`，连续 3 次把目标置为 `error` 并停止监控。用户得到误导性提示，真实原因是抓取/解析失败。
- **验证方式**: 代码路径与行号逐条核实成立（parse-sections.ts:15-16 与 41-42 两处 `return []` 语义相同；scheduler.ts:130-137 确实只按 `null` 处理；noteFailure 第 3 次置 `status='error'` 见 199-210）。
- **降级理由（原报告夸大了"一次慢页面"这一半）**: 原报告把"结果页加载慢于 8 秒"与"表头变动"并列为触发条件，但 query-client.ts:67 的 `waitForSelector(..., { timeout: 8000 }).catch(() => undefined)` 是**真正的上游保护**——它会一直等到表格出现，只要页面最终在 8 秒内出现表格就仍会正确解析；超时被吞掉之后 `content()` 读到的仍可能是完整文档，也只是"可能"解析为空。另外真实 Minerva 的结果表列结构未变动前，这条路径不会自行触发。因此它是"页面改版/结构漂移时的静默锁死"这一**健壮性缺口**，而非日常运行中会碰到的故障。
- **最终判定**: **downgraded / low**
- **建议**: 让解析层区分"页面无结果"与"页面结构不认识"（返回标志位或抛 ParseError），后者记明确 error 事件且不计入"CRN 不存在"的失败连击，必要时保留上轮 `lastStats`。

### [low] 会话超时页的识别只靠两段 body 文本，兜底规则却把任何 pban1 URL 判为已登录

- **位置**: packages/server/src/session/session-status.ts:20,37,39；配合 packages/server/src/session/session-manager.ts:48
- **触发路径**: 会话在别处被挤掉/自然过期后，`checkStatus()` 探测 `bwskfreg.P_AltPin`，若此时 body 文本取不到或不含 `login to minerva` / `user login`，判定落到第 3 条规则 `if (url.includes(AUTH_BASE)) return 'authenticated'`。
- **后果**: 超时会话被判为 authenticated → `ensureLoggedIn` 提前 return（session-manager.ts:76），调度器用死会话继续查询，每轮查询在 `selectOption` 上耗 30s 后抛错，连错 3 次目标变 `error`，用户看到"查询失败"而非"请重新登录"。
- **验证方式**: 规则顺序、行号、注释、测试全部核对无误 —— session-status.ts:14-19 的注释明确写着"Banner serves that page at a pban1 URL (title "User Login")"，测试 session-status.test.ts:41-48 正是在 pban1 URL 上用 body 文案覆盖，两条 `LOGIN_URL_MARKERS`（session-status.ts:4-12）确实不含 pban1 的超时页路径；session-manager.ts:47-49 只读 `innerText('body')` 且把读取失败吞成空串，`<title>` 完全不参与判定。
- **降级理由（关键一步无法验证）**: 整条推断的**唯一支点**是"真实 Minerva 超时页的 body 里不含这两段小写文案"。而代码注释自己说该页 title 是 "User Login"，Banner 的会话超时页通常也会在正文出现 "User Login"/"Please login" 之类的字面文本；若确实如此，第 2 条规则会先命中并正确判为 logged-out，本发现就不成立。仓库内只有合成 fixture，无真实页面样本，我也无法联网访问 Minerva（需登录的校内页面）。因此这是一个**未验证的脆弱性**，不是已确认的失效路径。
- **最终判定**: **downgraded / low**（机制成立、后果无法确证；置信度不足以维持 medium）
- **建议**: 把 `page.title()` 一并纳入判定（title 是最强的信号却完全没被使用）；或在 pban1 页面加一条正向"已登录"锚点（登录表单不存在 / 出现 Quick Add-Drop 表单），不要用 URL 兜底推断已登录。

### [low] 登录失败原因被完全丢弃，浏览器没起来时用户只能看到"未登录"

- **位置**: packages/server/src/api/server.ts:176-177
- **触发路径**: 点击会话页 Login（Session.tsx:57-69）后出现：Chromium 未安装（未跑 `browser:install`，`launchPersistentContext` 直接抛 "Executable doesn't exist"）、profile 目录被占用、SSO 卡到超时、登录中被关窗。
- **后果**: `catch { sessionStatus = 'logged-out'; }` 既不打日志也不发事件；前端只能显示"已登出 —— 登录后轮询才能运行"（i18n/index.ts:62），用户无法区分"确实未登录"与"浏览器启动失败"，只能反复点击同一个必败流程。对照 CLI 脚本会把失败打出来（register-script.ts:44-47）。
- **验证方式**: 逐条核实成立 —— api/server.ts:162-184 的 `POST /api/session/login` **同步返回 `{started:true}`**，真正的工作在未被 await 的 async IIFE 中；因此 `api.login()`（web/src/lib/api.ts:60）立刻 resolve，`await session.refetch()` 读到的只是 `'logging-in'`，Session.tsx:64-66 的 `catch`/`errbar` 对登录失败**永不触发**；失败最终只表现为状态回落到 'logged-out'。触发条件也被我在本机直接撞到：该仓库的 playwright-core 1.60 需要的 `chromium_headless_shell-1223` 并未安装，`launchPersistentContext` 实测抛 `Executable doesn't exist at ...chrome-headless-shell.exe` —— 即"浏览器没起来"是开箱即遇的真实场景。全仓库 grep 确认 `closeSession` 只被三个 CLI 脚本使用（register-script.ts:40、query-script.ts:36、login-script.ts:21），API 进程没有任何 SIGINT/SIGTERM 或退出钩子。
- **与原报告冲突的子论断（已证伪）**: 原报告称"崩溃/强退后 Chromium 继续占用 .browser-profile，使下次 launch 更易失败"。实测：父进程因 unhandled rejection 退出时，其 spawn 的子进程（Chromium 的替身）**随父进程一同被终止**（探针输出 `child was terminated with the parent`），因此"孤儿 Chromium 占用 profile"这一因果链在原报告描述的崩溃场景下不成立。此外，若浏览器从未启动成功，用户"Start all"后第一次 tick 就会按发现 1 崩掉 API 进程（而非静默挂着），所以"反复点击同一个必败流程"的实际体验也被发现 1 的崩溃打断。这部分从后果中剔除。
- **最终判定**: **downgraded / low**（错误静默丢弃与无关闭钩子成立且值得修，但影响是"用户困惑 + 需要重启"，不构成功能或数据损坏）
- **建议**: catch 中保留 error，`console.error` 并通过 store/WS 事件流广播 error 事件（UI 的 errbar 已有展示位）；顺带把登录改为返回可轮询的错误码/事件，而不是只靠 `sessionStatus`；给 API 进程加 SIGINT/SIGTERM 与退出钩子。

### [low] 启动时把所有 watching 目标静默改为 paused，不写任何事件，监控停止无迹可查

- **位置**: packages/server/src/api/main.ts:12；packages/server/src/store/store.ts:134-144
- **触发路径**: 任何一次 API 进程重启（正常重启、用户 Ctrl+C、或发现 1 描述的崩溃）。
- **后果**: `pauseAllWatching()` 直接把 `status` 从 `watching` 改成 `paused` 并落盘，**不产生任何 LogEvent、不发 WS 事件、不入通知**；用户回来只看到一排 paused 卡片和空荡荡的日志控制台，无从知道"这些原本在盯位、是重启把它们停掉的"。若这次重启正好源于发现 1 的崩溃，则用户看到的结果是"监控无声无息地停了"，而日志里最后一条可能是半小时前的正常轮询记录。
- **验证方式**: main.ts:12 调用 `runtime.store.pauseAllWatching()`；store.ts:134-144 的实现只做 `t.status = 'paused'` 与 `this.save()`，没有 `appendEvent`。全仓库没有其他地方为这次状态变更补记事件（grep `pauseAllWatching` 仅 store.ts:134 定义与 main.ts:12 调用）。原报告在发现 1 的"后果"里提到了这一行为，但只当作崩溃的附带影响，遗漏了"**即使没有崩溃**，这次状态迁移本身对用户完全不可见"这一点，因此单列为一条独立（低severity）发现。
- **最终判定**: **new / low**（不在 critical/high 之列，但为亲手验证的独立缺陷；如需压缩条目可并入发现 1）
- **建议**: 在 `pauseAllWatching()` 之后由 main.ts 通过事件流记一条 `warn` 事件（例如 "Reset N watching target(s) to paused on startup"），前端即可在控制台看到原因；或改为保留 watching 并在 UI 上提示需手动恢复。

## 验证方法备注

- 全程只读：`git status --porcelain` 在复核前后均为空，仓库未做任何修改。临时探针脚本建在仓库外的 `Auto-Register/tmp-verify/` 并已删除。
- 两条 Playwright 语义断言的实测环境：仓库内 `playwright-core@1.60.0`（`node_modules/playwright-core/package.json`）+ 本机 `%LOCALAPPDATA%/ms-playwright/chromium-1217/chrome-win64/chrome.exe`（仓库自身所需的 `chromium_headless_shell-1223` 未安装，故显式指定 executablePath）。
- 进程崩溃实验：`node v24.5.0`（仓库 engines 要求 `node >=22`）。
