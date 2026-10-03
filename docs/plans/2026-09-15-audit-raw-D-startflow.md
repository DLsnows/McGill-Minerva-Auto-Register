# D · 启动与状态转换流程（添加课程 → 开始轮询）— 对抗性验证后报告

> 验证者：对抗性审计（独立打开每一条发现引用的文件/行号复核，逐跳追踪调用路径）
> 目标仓库（只读，未改动任何文件）：`C:/Users/lenovo/deepseekHarness/Auto-Register/wt/audit`（`git status --porcelain` 为空）
> 原始报告：`audit-findings/D-start-flow.md`（7 条发现）

## 验证方法

对原报告 7 条发现逐条独立复核：读取被引用的源文件与行号、追踪真实调用路径（含 `addTarget` 默认值、`stop-all`/`start-all` 端点、前端 `disabled` 守卫、`tick` 过滤条件）、检查上游守卫与 else 分支，并对照显式设计意图（源码注释、`docs/superpowers/` 计划与规范、以及引入这些行为的提交 `8b60287` 的提交信息与测试断言）。对崩溃类结论，另在本机实测了所用 Node 版本的未处理 rejection 语义。

**结论概览**：`confirmed` 3 条 · `downgraded` 3 条 · `refuted` 1 条 · `new` 1 条（high）。

**主结论成立**：「引擎是否运行（内存态 `Scheduler.timer`）与课程状态（磁盘态 `target.status`）解耦、而主按钮语义只由后者决定」——这一点经代码与历史提交双重确认：`docs/superpowers/plans/2026-06-02-p7b-web-pages.md:579-588` 原本规定 `running={scheduler.data?.running ?? false}`（直接用引擎状态），提交 `8b60287` 的子提交 “fix(web): master toggle reflects watching courses, not the engine flag” 把它改成了由 `anyWatching` 驱动。于是引擎未运行时按钮已显示「■ 全部停止 / 监控 · 运行中」，而按 README.zh.md:136 的正常流程（先加课、再回 Dashboard 点 Start all）第一次点击执行的是 `stop-all`。

原报告最严重的一条（`tick()` 未捕获 rejection）**完全成立且已实测**：Node v24（仓库 `engines.node >= 22`）对 `void p.finally(...)` 形式的未处理 rejection 直接终止进程，全仓无任何 `unhandledRejection`/`uncaughtException` 处理器。

同时，原报告有三处需要纠正，其中一处是明确证伪：

1. **「首次设置后点开始不生效」的因果表述需收紧**——README 的「启动时每门课都是暂停」作用域是**进程启动**，该行为由 `pauseAllWatching()` 真实执行、是成立的；真正的错位是**运行中途新增的课程不遵守同一默认值**。另外「重新编辑/添加课程即可恢复」不成立（编辑不改状态，重新添加会再造一个 `watching` 目标、把同一陷阱再触发一次）。
2. **「静默 30 秒」只对新建目标成立**——被恢复的目标保留旧的 `nextPollAt`，首轮最长可等一整个间隔（默认 30 分钟 ± 3），预算退避后是到次日凌晨。
3. **「logged-in 为假时点击被静默吞掉」证伪**——那两个 early return 所在的按钮在同一份 session 数据下就是 `disabled`，不存在“可点但无反应”的窗口。

另外，本次复核发现原报告**漏掉一条 high**：`error` 是死状态，且“按日志提示修好课程数据”这一最自然的修复动作不会恢复监控（见 NEW-1）。

---

## Confirmed（证据成立，严重度维持）

### [high] 主开关语义由课程状态而非引擎状态决定：初次设置后它显示「全部停止」，第一次点击执行 stop-all

- **位置**: `packages/server/src/store/store.ts:107-112`（默认 `watching`）、`packages/web/src/pages/Dashboard.tsx:106,114,126,140`、`packages/web/src/components/SchedulerToggle.tsx:19,24,28`、`packages/server/src/api/server.ts:95-99,205-210`、`packages/web/src/pages/Courses.tsx:29-37`
- **触发路径（已逐跳核对）**: `POST /api/targets`（server.ts:95-99）→ `store.addTarget(parsed.data)`，前端 body 不含 `status`（Courses.tsx:29-37）→ `status: input.status ?? 'watching'`（store.ts:111）→ Dashboard `anyWatching=true`（Dashboard.tsx:106/126）→ `SchedulerToggle running={anyWatching}`（:140）渲染成「监控 · 运行中」+「■ 全部停止」（SchedulerToggle.tsx:19,24,28；i18n zh `scheduler.running/stop`）→ 点击走 `anyWatching` 分支 → `api.stopAll()`（:114）→ `stop-all` 把 watching 全改 paused 并 `scheduler.stop()`（server.ts:205-210）。而 `main.ts` 全篇没有 `scheduler.start()`，所以此刻引擎确实从未启动。
- **影响**: 与 README.zh.md:136-139 记载的首次使用流程（登录 → Courses 添加课程 → Dashboard 点 Start all）正面冲突：第一次点击得到的是「暂停课程 + 停止引擎」，控制台不新增任何轮询日志（`stop-all` / `scheduler.stop` 都不写事件），与期望完全相反。UI 上还有第二处同源误导：顶部 Ticker 的「监控中 N」也取自 `target.status`（`App.tsx:37`），引擎停着却显示有课程在监控。
- **证据（补强）**: `docs/superpowers/plans/2026-06-02-p7b-web-pages.md:579-588` 的计划版本是引擎状态驱动；提交 `8b60287`（“feat: per-course pause/resume + Start all / Stop all (#16)”）的子提交明确把语义改成“标签与动作都由是否有课程 `watching` 决定”。`Dashboard.tsx:103-105` 的注释即该意图的自述。
- **修正原报告**: (1) 「与 README『启动时每门课都是暂停』相反」不准确——README 那句的作用域是进程启动，且由 `pauseAllWatching()`（store.ts:134-144）真实执行；(2) 「须再点一次，或者重新编辑/添加课程才能恢复」不成立——编辑课程不改状态（Courses.tsx:39-46 只发查询字段，`targetPatchSchema` 中 status 可选），重新添加只会再造一个 `watching` 目标并重复触发同一陷阱。唯一恢复方式是第二次点主按钮（此时标签才变成「全部启动」）或重启进程。
- **建议**: 把按钮的 running/动作绑定 `GET /api/scheduler` 的真实 `running`（回到 p7b 计划的设计），或让 `POST /api/targets` 明确决定新目标状态（默认 `paused`，与 boot 归一化一致），不要再用 `target.status` 代理引擎状态。

### [critical] tick() 未捕获 isLoggedIn() 的 rejection：一次探测抛错即触发未处理 rejection，整个本地服务崩溃且不自愈

- **位置**: `packages/server/src/scheduler/scheduler.ts:105-109,311-317,330-338,80-91`、`packages/server/src/session/session-manager.ts:29-31,34-37,56-60`
- **触发路径（已核实）**:
  - `runCycle` 中唯一的无保护 await 就是 `this.deps.session.isLoggedIn()`（:105）；`checkCourse`（:120-127）与 `act`（:182-189）都有 try/catch。
  - 抛错源真实存在：`isLoggedIn()` → `checkStatus()` → `page.goto(PROTECTED_PROBE_URL, …)`（session-manager.ts:56-58）在断网/Minerva 维护时 reject；用户关掉 Playwright 窗口时 `context.on('close')` 把 `this.context` 置 null（:29-31），下一次 `getPage()` 走 `requireContext()` 抛 `SessionManager not launched — call launch() first`（:34-37）。
  - 冒泡路径无任何 catch：`runCycle` → `runOnce`（只有 `try/finally`，:86-90）→ `tick()` 的 `await this.runOnce(t.id)`（:336）→ `void this.tick().finally(...)`（:314-316，只有 finally，不消费异常）。
- **影响**: 进程级、无条件死亡：API + Web 控制台一起消失，前端 WS 以 ≤30 秒退避**永不放弃**地重连（`useEventStream.ts:47-52`，界面长期停在 Console.tsx:42 的「重连中…」），所有课程的轮询停摆且无自动恢复；下次启动 `pauseAllWatching()` 又会把残留 `watching` 全部改回 `paused`，用户必须重新点「全部启动」。
- **证据（新增实测）**: 本机 Node v24.5.0（仓库 `engines.node >= 22`，`.nvmrc` = 22）执行 `node -e "const p=Promise.reject(new Error('probe boom')); void p.finally(()=>{}); setTimeout(()=>console.log('STILL ALIVE'),200)"` → 进程以 **exit code 1** 终止，`STILL ALIVE` 从未打印。全仓（含 docs/CI/配置，排除 node_modules）grep `unhandledRejection|uncaughtException` **零命中**，无兜底、无 supervisor。
- **可达性边界（写清，但不影响定级）**: 崩溃需要一次 tick 里存在**到期**目标（`tick` 先按 `status==='watching' && (nextPollAt ?? 0) <= now` 过滤，:332-334）。点过「全部启动/恢复」后目标多为 `nextPollAt` 未定义或已过期 → 首个 tick（≤30 秒）即命中。README 与 Session 页都在提醒“别关那个自动化浏览器窗口”（i18n `session.dontCloseBrowserNote`），说明这是现实操作路径。`POST /api/targets/:id/run`（⚡ 立即执行）**不受影响**——`runTarget` 挂了 `.catch`（scheduler.ts:219-223）。
- **修正原报告的一处推论错误**: “崩溃前最后一轮若已 `store.updateTarget(...,{status:'paused'})`（:106），重启后看起来就像『自己停了』”不成立——第 106 行只在 `isLoggedIn()` **正常返回 false** 时执行（该情形不抛错、不崩溃）；若是**抛错**则走不到 106，而一旦目标已 `paused`，下一轮 `runCycle` 在第 96 行就返回，不会再触发探测。正确表述是：崩溃后重启时 `pauseAllWatching()` 把 `watching` 全部复位为 `paused`，于是“重启后课程自己停了”。
- **建议**: `tick()` 内对每个 `runOnce` 加 try/catch（失败记日志并继续下一个目标），定时器加 `.catch()`；`isLoggedIn()` 异常按“会话不可用”处理（等同返回 false 的暂停路径），并补进程级 `unhandledRejection` 兜底日志。

### [medium] start-all / Resume 恢复目标时不重算 nextPollAt：预算退避到午夜的目标，点「全部开始」也整晚不轮询

- **位置**: `packages/server/src/scheduler/scheduler.ts:99-103,295-300,288-292`、`packages/server/src/api/server.ts:144,198-203`、`packages/web/src/pages/Dashboard.tsx:69-85`
- **触发路径（已核实）**: 预算耗尽时 `scheduleAfterReset` 把 `nextPollAt` 设为「本地午夜 + 1–6 分钟」（:295-300，唯一调用点 :101）；`rescheduleWatching()`（:288-292）**全仓只被 `PUT /api/settings` 调用**（server.ts:144，grep 确认仅此一处）；`start-all`（server.ts:198-203）与单课 Resume（Dashboard.tsx:75-76 → PATCH + `POST /api/scheduler/start`）都不碰 `nextPollAt`；`pauseAllWatching`（store.ts:134-144）同样不碰；而 `tick` 只轮到期的目标（:332-334）。因此 stop-all → start-all（或 Pause → Resume）后目标显示「监控中 / 运行中」，却要等到旧的 `nextPollAt` 才真正轮询。
- **影响**: 状态与行为再次不一致（“看着在跑其实没动”）：卡片长期「尚未轮询/上次轮询很久前」、控制台静默；重启进程也不修正（重启只做 pause，时间戳原样保留）。
- **证据（补强）**: 不止“预算退避”这一极端场景——**任何** paused→watching 都保留旧时间戳，所以「全部启动」后的首轮最长可等一个完整间隔（默认 30 分钟 ± 3，`shared/src/store-types.ts:78-79`），这也正是 REF-3 里“静默可能远超 30 秒”的来源。
- **修正原报告**: “重启进程也无法修正”成立；但退避本身**会自愈**——到本地午夜 `store.getDailyOps` 因日期变更返回归零快照（store.ts:183-189），`canQuery` 恢复，1–6 分钟后正常轮询。危害是数小时静默，不是永久停摆。
- **建议**: `start-all` / 单课 Resume 成功后对刚恢复的目标调用 `rescheduleWatching()`（或清空过期的 `nextPollAt`），让“点开始”等价于“进入轮询队列”。

---

## Downgraded（成立但严重度降低）

### [medium]（原 high）「必须彻底重启再点全部开始」的不对称性：只有 boot 时的 pauseAllWatching 会纠正该错位

- **位置**: `packages/server/src/api/main.ts:10-13`、`packages/server/src/store/store.ts:134-144`、`packages/server/src/api/server.ts:198-203`
- **已核实**: `pauseAllWatching()` 只在 `createRuntime` 之后执行一次（main.ts:12），仅做 `watching → paused`（store.ts:136-140）；`start-all` 是唯一“恢复 paused + 启动引擎”的原子路径（server.ts:198-203）；此后没有任何代码把 `watching` 归一化回 `paused`。
- **降级理由**: 它与 D-1 是**同一根因的机制说明，不是独立缺陷**（原报告自己也说“这是报障 2『必须重启才正常』的直接原因”）。作为独立条目评 high 会把一个缺陷计两次；修掉 D-1 后本条自动消失。
- **修正**: 「问题表现随机化」不成立——同一进程生命周期内是**确定性**的：运行中加课必中，若在加课之前重启则不中；重启只在下一次加课之前有效。
- **设计意图提示**: boot 不自动恢复轮询是显式意图（提交 `8b60287`: “On boot, reset every persisted 'watching' target to 'paused' so the app never resumes polling on its own”，另见 main.ts:10-11、store.ts:131-133 注释）。因此原报告「去掉靠改状态对齐 UI 的启动归一化」的建议应改为：**保留“启动不自动轮询”的保证**，但让 UI 读引擎真实状态，而不是改写磁盘状态去迁就 UI。
- **建议**: 同 D-1。

### [medium]（原 high）start() 只装定时器不立即 tick，且 UI 不显示引擎真实状态与 nextPollAt，点完开始后彻底静默

- **位置**: `packages/server/src/scheduler/scheduler.ts:308-318`、`packages/web/src/components/CourseCard.tsx:72-74`、`packages/web/src/App.tsx:36-45`
- **已核实**: `start()` 只 `setInterval`，不触发首次 `tick()`（:309-318）；`nextPollAt` 由 `scheduleNext`/`scheduleAfterReset` 写入（:282,:298），但在 `packages/web` 内**零引用**（全仓 grep 仅命中 shared/types 与 server 及其测试）；`scheduler` 资源虽在 `DataContext.tsx:22` 拉取、在 `Dashboard.tsx:81` 重新拉取，却没有任何组件渲染它（全 web grep 只有 refetch 用法），`isRunning()` 的真相到不了界面；卡片只显示 `lastPolledAt`。点击后 0–30 秒内确实没有新日志（`start()`/`start-all`/`updateTarget` 都不写事件），页面唯一反馈是按钮标签互换；若此时再点一次主按钮，`anyWatching` 已为 true → 走 `stop-all`（与 D-1 合流）。
- **降级理由**: 事实全部成立，但这是**可观测性/UX 缺陷而非功能失效**——引擎确实在跑，新建目标 `nextPollAt` 为 undefined，`tick` 按 `(t.nextPollAt ?? 0) <= now` 视为到期（:334），首次轮询最迟 30 秒内发生。它放大了误判，但不会让轮询丢失，故 high 偏高。
- **修正/补强**: 「30 秒静默」只对**新建**目标成立；对**被恢复**的目标可能长达一整个轮询间隔甚至数小时（见 D-3）。这让“无法区分已启动/未启动”更容易发生，但性质仍是 medium。原报告旁注“重复点主按钮会走向相反的 stop-all”经核对成立。
- **建议**: `start()` 装好定时器后立即 `void this.tick()`；卡片展示 `nextPollAt`（“已排队，预计 HH:MM”）；把 `GET /api/scheduler` 的 `running` 真正显示出来。

### [low]（原 medium）inFlight 丢弃并发轮次时无反馈：点击「立即执行」可能整轮不产生结果

- **位置**: `packages/server/src/scheduler/scheduler.ts:60-62,80-91`、`packages/server/src/api/server.ts:115-125`、`packages/web/src/pages/Dashboard.tsx:87-98`
- **已核实**: `runOnce` 在 `inFlight` 命中时直接 return（:81-84）；`/run` 无论是否被丢弃都返回 `started:true`（server.ts:123-124），前端 `onRun` 在响应回来即清除「… 执行中」（Dashboard.tsx:87-98），按钮确实只闪一下。
- **降级理由（两处修正）**:
  1. 原摘要写「既无『已轮询』也无报错」不准确：命中时会写一条 **info** 事件（`Run already in progress for this target — skipping concurrent run`，:82），经 `appendEvent → onEvent → broadcast`（runtime.ts:34-37、server.ts:266-276）到前端，Console 是渲染 info 行的（Console.tsx:6-12,51-56）。真正不可见的只是“这次点击没被执行”这一语义（返回值无法区分接受与丢弃）。
  2. 危害有限：目标处于 inFlight 就意味着**此刻正在为它跑一轮**，用户“现在查一次”的诉求基本已被满足；只有带 `force` 的一键执行（绕过 notify/dry-run 闸门）会真的丢掉，等一轮即可重试。
- **设计意图**: 跳过并发是显式且有意为之（:60-61 注释 + `scheduler.test.ts:326-355` “skips a concurrent run of the same target (no double registration)”）。去掉守卫会引入重复注册，比现状更糟。
- **建议**: `inFlight` 命中时把结果回传（`/run` 返回 `started:false, reason:'in progress'`）或排队执行一次，前端据此提示「正在执行中」。

---

## New（原报告遗漏，本次新发现）

### [high] `error` 是死状态：连续 3 次失败后课程永久停止轮询，而修好课程数据的唯一正常动作不会把它救回来

- **位置**: `packages/server/src/scheduler/scheduler.ts:41-48,93-96,199-210`、`packages/web/src/components/CourseCard.tsx:19-31,49-59,63`、`packages/server/src/api/server.ts:198-203`、`packages/web/src/pages/Courses.tsx:39-46`
- **触发路径（已核实）**: 任意 3 次连续失败 → `noteFailure` 把状态写成 `error` 且**不重排** `nextPollAt`（scheduler.ts:199-210；调用方随即 `return`，不再 `scheduleNext`）。计入的失败包括 `checkCourse` 抛错（网络抖动 / Minerva 页面变动，:120-127）、CRN 不在结果里（:130-138）、注册返回 `error` 类结果（:250-254）。此后：
  - `runCycle` 对非 `watching` 目标直接返回（:96），所以它再也不会被轮询（`scheduler.test.ts:233-235` 明确断言 “Now stopped: a further run does not query again”）；
  - 卡片对 `error` 不渲染 Pause/Resume（`PAUSABLE=['watching']` / `RESUMABLE=['paused']`，CourseCard.tsx:22-23,49-59），「⚡ 立即执行」因 `canRun=false` 而 disabled（:29,63）；
  - 主按钮「全部启动」只恢复 `paused`，`error` 明确跳过（server.ts:199；`server.test.ts:346-365` 断言 error 保持不变）；
  - **编辑课程也救不回来**：Courses 页保存只 PATCH `term/subject/courseNumber/targetCrn/faculty/label/mode`（Courses.tsx:39-46），不含 `status`，于是“按日志提示把 CRN/学期/科目/学院改对”之后状态仍是 `error`；
  - 全前端唯一写 `status` 的地方是 `Dashboard.tsx:75`（Pause/Resume，仅 watching↔paused），因此 **UI 里没有任何一条路径能把 `error` 改回 `watching`**（grep 确认）。唯一办法是删除课程再重新添加，代价是丢掉 label 与 lastStats，而界面上没有任何提示。
- **影响**: 用户在“以为正在监控”的科目上永久失去抢课机会，且恢复路径不可发现（唯一的“修复数据”动作静默无效）。触发源包含纯瞬时条件（一次网络中断/探测抛错即可累计 3 次）。
- **为什么算缺陷（同时说明与显式设计意图的边界）**: 提交 `8b60287` 的子提交 “fix(web): error and completed courses are terminal — no Resume … so a known-bad or finished course can't be revived from the card”、CourseCard.tsx:19-21 的注释、`CourseCard.test.tsx:71-80` 的测试都表明「卡片上不给 error 复活入口」是**有意的**，FAILURE_LIMIT 也是有意设计（scheduler.ts:41-48 说明“重试只会烧预算”）。本条不是主张“卡片该加 Resume”，而是三个未被设计的缺口：
  1. 设计规范的状态机是「watching ──操作失败(报错)──► 记录并报告 ──► watching（继续轮询）」（`docs/superpowers/specs/2026-06-01-autoregister-design.md:94`），实现改成终止态后**没有配套任何恢复通道**；
  2. 日志自己引导用户去 “check the CRN, term, subject, course number and faculty”（scheduler.ts:134），而**改对这些字段并不会恢复监控**；
  3. 与本 lane 的其它条目同源：状态是磁盘态、行为是内存/引擎态，用户能看到的“监控中”与真正在跑的轮询再次脱节。
- **建议**: 保留“error 不再自动重试”的语义，但补一条显式恢复通道（卡片上的「重新监控」按钮，或让 `PATCH` 查询字段时把 `error` 复位为 `watching` 并 `scheduleNext`），并让 `start-all` 的返回/提示明确说明“N 门课程因错误被跳过”。

---

## Refuted（不成立）

### [refuted]（原 medium）logged-in 判定为假时两处入口静默 return：点击被吞掉且无任何提示

- **原位置**: `packages/web/src/pages/Dashboard.tsx:72,108`、`packages/web/src/lib/useResource.ts:51-53`
- **证伪理由**: 两处守卫所依赖的 `session` 数据与按钮的 `disabled` 条件**来源完全相同**：主按钮 `disabled={busy || (!running && !canStart)}`，`canStart={loggedIn}` 取 `session.data?.status === 'authenticated'`（:128,144），`running` 取同一个 `list`（:126）；卡片 Resume `disabled={canResume && !loggedIn}`（CourseCard.tsx:53）。未认证时按钮就是 disabled，点击事件不会触发，因此**不存在**“按钮可点但回调直接 return”的窗口（ref 在每次 commit 后的 effect 中同步，:26-31，也不落后于渲染态）。代码注释本身就是这个意图：“No resuming/starting a task while logged out (**the button is disabled too**)”（Dashboard.tsx:71）。
- **测试固化**: `Dashboard.test.tsx:103-110`（未登录时 Start all 为 disabled）、`CourseCard.test.tsx:60-69`（未登录时 Resume / Register now disabled，Pause 保持启用）。
- **原报告自身矛盾**: 其第二种触发“服务端会话已过期而前端缓存非 authenticated”不成立（缓存非 authenticated → 按钮 disabled）；真正会发生的“前端缓存 authenticated 但服务端已过期”并不静默——请求会通过，下一轮 `runCycle` 把目标置为 `paused` 并写 warn 日志（scheduler.ts:105-108）。
- **结论**: 该守卫属防御性死代码，最多算可读性冗余，不构成缺陷。

---

## 已核实但未单列（medium 以下，供维护者参考）

1. **`stop-all` / 单课 Pause 不会取消正在执行的轮次（medium）**: `scheduler.stop()` 只 `clearInterval`（:320-323），`runCycle` 只在开头检查一次状态（:96），之后到 `actor.act`（:183）之间没有任何状态复检或取消机制。若用户在某一轮进行中（查询 + 多次 `humanPause`，常达数十秒）点「全部停止」/「暂停」，该轮仍可能提交注册并把状态改成 `registered` —— “停止”不是真正的急停。建议在 act 前复检 `store.getTarget(targetId)?.status === 'watching'`。
2. **`runCycle` 持有 store 内的活对象引用（low）**: `store.getTarget()` 直接返回数组里的对象（store.ts:95-97），`updateTarget` 用 `Object.assign` 原地修改（:121），所以 `runCycle` 在 :95 取得的 `target` 会在整轮中随用户编辑而变；查询用的是 :111-117 的快照（旧 CRN），执行用的是 :183 的实时 `target.targetCrn`。用户在“查询完成→执行”窗口内改 CRN，会出现“按旧 CRN 的余量决策、对新 CRN 动手”的错配。建议在 `runCycle` 开头做一次浅拷贝。
3. **`runCycle` 的失败路径不消耗注册预算但计入失败streak（low，仅记录）**: `checkCourse` 抛错时先 `budget.recordQuery(now)` 再 `noteFailure`（:122-127），行为一致、无需修改；此处仅说明 FAILURE_LIMIT 的计数与预算无关。

## 复现要点（已验证，供维护者）

1. **主路径**: 清空 `data/store.json` → `npm run serve` → Session 页登录（登录成功后 `session.refetch()` 会更新共享 session 资源，Session.tsx:63，所以 Dashboard 按钮会解禁）→ Courses 页添加一门课 → Dashboard（不重启进程）：主按钮此刻就是「■ 全部停止 / 监控 · 运行中」，点一次后课程变「已暂停」、引擎被 `stop()`、控制台无新行。
2. **不对称性**: 同上，但在添加课程之前先 Ctrl+C 重启进程；启动日志会打印 `Reset N watching target(s) to paused on startup.`，按钮变「▶ 全部启动」，点一次即恢复 `watching` 并启动引擎。
3. **崩溃**: 保持引擎运行且在监课（存在到期目标），关闭 Playwright 的 Chromium 窗口，等 ≤30 秒 → `isLoggedIn()` 抛 `SessionManager not launched`，`tick()` 的 rejection 无 catch → 进程退出；页面控制台进入「重连中…」并不再恢复。
4. **死状态**: 让某门课连续 3 轮失败（例如故意写错 CRN）→ 角标变 ERROR；此后「全部启动」不会恢复它，编辑并保存该课程也不会，只能删除后重新添加。
