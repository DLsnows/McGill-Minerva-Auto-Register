# A 调度器与运行时并发 — 对抗性验证后报告

> 验证者：对抗性复核（对原报告每一条独立打开被引用文件与行号，重走调用路径、上游守卫与 else 分支，并核对源码注释、`docs/superpowers/` 规范/计划与测试中固化的显式设计意图）
> 目标仓库（**只读，未改动仓库任何文件**）：`C:/Users/lenovo/deepseekHarness/Auto-Register/wt/audit`
> 原始报告：`audit-findings/A-scheduler-runtime.md`（7 条发现）
> 结论概览：**`confirmed` 6 条 · `downgraded` 1 条 · `refuted` 0 条 · `new` 0 条**

## 验证方法

1. **逐条重放触发路径**：对 7 条发现分别打开 `scheduler.ts`(339 行)、`session-manager.ts`、`store.ts`、`api/server.ts`、`api/main.ts`、`query-client.ts`、`register-client.ts`、`parse-register-result.ts`、`CourseCard.tsx`、`Dashboard.tsx`、`Courses.tsx`、`SchedulerToggle.tsx`、`Settings.tsx`，按行号核对每段引用代码是否与原文一致，并检查该 `await` 的**外层是否真的没有 try**、分支是否被上游守卫拦掉。
2. **反向搜索反证**：仓库（packages/docs/配置，node_modules 被 gitignore 排除）grep `unhandledRejection|uncaughtException|process.on` **零命中**，另对 `node_modules/fastify` 单独 grep 确认它只在自带测试里出现、不注册进程级处理器；`mutex|queue|semaphore|lock` 在 `packages/server/src` 只命中 `clock`/`blocks` 这类词内子串，**没有任何互斥/串行队列结构**；`.tick(` 确认 `tick()` 只被 `start()` 的 interval 调用；`failureStreak` 5 处全在 scheduler.ts 内；`rescheduleWatching` 唯一调用点是 `PUT /api/settings`。
3. **设计意图核对**：源码注释（scheduler.ts:41-48/60-61/76-79/195-198/258-259/294；store.ts:34-38/131-133；session-manager.ts:26-28；server.ts:111-114/196-197；CourseCard.tsx:19-21）、规范 `docs/superpowers/specs/2026-06-01-autoregister-design.md:87-99`、计划 `docs/superpowers/plans/2026-06-02-p5a-store-scheduler.md:170`、以及 `scheduler.test.ts` / `store.test.ts` / `server.test.ts` / `CourseCard.test.tsx` 的断言。
4. **跨 lane 去重**：与本工作区其它已验证报告（`D-start-flow.verified.md` 等）比对，避免同一缺陷在汇总时被计两次（见文末「跨 lane 去重」）。

**总体结论**：原报告 7 条发现的**行号、代码引用与触发链路全部核对无误**，没有一条建立在想象中的调用顺序上，也没有被上游守卫挡住（因此 `refuted = 0`）。需要纠正的是**一条严重度定级**（另一条候选降级经复核后被否决）与**三处子论断的边界**：

- **A-4（预算拉伸无午夜上界）被降级为 low**：原文的数值示例（queryBudget=2、2 门课 → 24h）算出的恰好是该预算下的**公平份额**（2 次/天 ÷ 2 门课 = 每门每天 1 次），"一整天只轮询一次"是预算不足的正确结果而不是拉伸算错；真正有害的部分要么需要 `remainingQuery < activeCount`（预算小于监控课程数）或 ×3 放大（已单列为 A-5），要么属于「改预算不重排」这一小缺口。
- **A-2（error 死状态）维持 high**：我一度准备按"终态是显式设计意图"降级，但规范 §5 的状态机写明 `watching ──操作失败(报错)──► 记录并报告 ──► watching（继续轮询）`，且 `error` 可由**纯瞬时**故障（查询连续 3 次抛错）触发、日志引导用户去改的字段又救不回监控，**没有任何恢复通道**——降级理由不成立。
- **三处子论断收紧**（不影响定级）：(a) `tick` 循环无 per-target try/catch 导致"后续目标被饿死"只在**存在全局 handler**（或非默认 `--unhandled-rejections`）时才可达，默认 Node 下进程先死；(b) A-5 的 ×3 对 **auto** 目标是注释里写明的意图，缺陷只在它没有 mode/dryRun 守卫；(c) A-7 的"没有 `.corrupt` 备份"仅在**重命名也失败**时成立（纯解析失败路径会留下备份）。

原报告主动声明的三项「非问题」（DST/本地午夜算术、`Store.save()` 单进程无丢更新、长跑内存无界增长的缺位）**经复核全部成立**，未发现需要翻案的误判（见文末）。

---

## Confirmed（证据成立，严重度维持）

### [critical] tick 定时器内的异常无人接管，unhandledRejection 直接终止服务进程

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:105-109,311-317,330-338,80-91`、`packages/server/src/session/session-manager.ts:29-31,34-37,56-60,63-65`
- **触发路径（已逐跳核实）**：`runCycle` 中唯一无 try 的 `await` 就是 `this.deps.session.isLoggedIn()`（:105；`checkCourse` :120-127 与 `act` :182-189 都有 try/catch）→ `isLoggedIn()` → `checkStatus()` → `getPage()`/`page.goto(PROTECTED_PROBE_URL)`（session-manager.ts:56-60）。抛错源真实存在：用户关闭那个 headful Chromium 窗口时 `context.on('close')` 把 `this.context` 置 null（:29-31），下一次 `getPage()` 走 `requireContext()` 抛 `SessionManager not launched — call launch() first`（:34-37）；断网/Minerva 维护时 `page.goto` 抛 TimeoutError。异常冒泡路径无任何 catch：`runCycle` → `runOnce`（:86-90 只有 `try/finally`）→ `tick()` 的 `for`（:335-337）→ `void this.tick().finally(...)`（:314-316 只有 finally，**不消费异常**，`.finally()` 派生出的 promise 无人接管）。
- **后果（已核实）**：仓库 `engines.node >= 22`（根 `package.json:10-12`），Node 15+ 对未处理 rejection 默认 `throw`；仓库源码/docs/配置 grep `unhandledRejection|uncaughtException|process.on` **零命中**，`node_modules/fastify` 内仅其自带测试文件出现该字符串（不注册运行时处理器）→ 进程直接退出：轮询停摆、HTTP/WS 全断（前端只能看到断线重连）。`tick()` 只被 `start()` 的 interval 调用（grep `.tick(` 确认），没有第二处消费者。
- **证据**：

```ts
// scheduler.ts:105-109  未被任何 try 包裹的 await（对比 :120-127 与 :182-189 都有 try）
if (!(await this.deps.session.isLoggedIn())) {
  store.updateTarget(targetId, { status: 'paused' });
  this.log('warn', 'Session not active (logged out / evicted) — paused; please re-login', targetId);
  return;
}

// scheduler.ts:311-317  rejection 无人消费
this.timer = setInterval(() => {
  if (this.ticking) return;
  this.ticking = true;
  void this.tick().finally(() => { this.ticking = false; });
}, tickMs);

// scheduler.ts:335-337  串行且无 per-target 隔离
for (const t of due) {
  await this.runOnce(t.id);
}

// session-manager.ts:34-37  上下文被关闭后必然抛
private requireContext(): BrowserContext {
  if (!this.context) throw new Error('SessionManager not launched — call launch() first');
```

- **验证结论：confirmed，维持 critical**。行号与引用代码逐字符一致；`.finally()` 的未处理 rejection 语义、缺少进程级兜底、`tick()` 无第二调用点三项均已独立核实。
- **修正一处子论断的边界**：原文写"即使装了兜底 handler，…一个目标的异常会中止该 tick 中其余所有 due 目标（顺序稳定→持续饿死后面的目标）"——该表述本身是**有条件**的，成立；但需写明两者互斥：默认 Node 下进程直接死亡，**饿死路径不可达**；只有在有人补了全局 handler（或改用 `--unhandled-rejections=warn`）之后，缺少 per-target try/catch 才会暴露为"第一个抛错目标饿死其后所有到期目标"。这条子论断不应单独计一次影响。
- **建议**：`runCycle` 里把 session 检查纳入已有 try/catch（按 query 失败计入 failure streak）；interval 回调改为 `void this.tick().catch(e => this.log('error', ...))`；`tick()` 循环内对每个目标单独 try/catch；另补进程级 `unhandledRejection` 兜底日志。
- **交叉印证**：lane D 的已验证报告独立给出同一条 `[critical]`（D-start-flow.verified.md）。

### [high] 连续 3 次失败置为 `error` 后，UI 与 "Start all" 都不提供恢复入口，目标永久停摆

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:199-210`（配合 `:93-96,120-138,250-254`）、`packages/server/src/api/server.ts:198-203`、`packages/web/src/components/CourseCard.tsx:19-23,29-31,49-59,63`、`packages/web/src/pages/Courses.tsx:39-46`、`packages/web/src/pages/Dashboard.tsx:69-85,115`
- **触发路径（已逐跳核实）**：三个入口都能累计 streak —— `checkCourse` 抛错（:120-127）、目标 CRN 不在结果中（:130-138）、`actor.act()` 返回 `kind:'error'`（:250-254；`parse-register-result.ts:69-70` 把任何非 closed/class full/waitlist 的提示都归为 `error`，含 Time Conflict / Prerequisite / Department Consent / Level Restriction）。第 3 次连续失败时 `noteFailure` 写 `status:'error'`、删 streak、**调用方随即 `return`，不再 `scheduleNext`**（:201-205 + :124/:135/:186/:252）。此后：`runCycle` 对非 watching 目标直接返回（:96），该目标再也不被轮询；课程卡 `PAUSABLE=['watching']`/`RESUMABLE=['paused']` 都不含 `error`，暂停/恢复按钮不渲染（CourseCard.tsx:22-23,49-59）；"⚡ Register now" 因 `canRun = status==='watching'` 而 disabled（:29,63）；主开关 `start-all` 只捞 `paused`（server.ts:199，测试 `server.test.ts:346-365` 断言 error 保持不变）；Courses 页编辑表单只 PATCH `term/subject/courseNumber/targetCrn/faculty/label/mode`（Courses.tsx:41-44），**从不改 status**。
- **后果（已核实）**：目标进入 UI 无法离开的终态；用户点 Start all 得到 `{running:true, resumed:0}`（server.ts:202），而前端 `onToggleScheduler` 完全不读该响应（Dashboard.tsx:115），界面零反馈。唯一 UI 出路是删除课程再重新添加（Courses 页有这两个按钮），代价是丢 label 与 lastStats，而界面无任何提示；`pauseAllWatching` 只规范化 `watching`（store.ts:134-144），重启进程也不会修正 `error`。
- **证据**：

```ts
// scheduler.ts:199-205
private noteFailure(target: WatchTarget, message: string, data?: unknown): boolean {
  const streak = (this.failureStreak.get(target.id) ?? 0) + 1;
  if (streak >= FAILURE_LIMIT) {
    this.failureStreak.delete(target.id);
    this.deps.store.updateTarget(target.id, { status: 'error' });
    this.log('error', `${message} — stopped watching after ${streak} consecutive failures.`, target.id, data);
    return true;                 // ← 调用方直接 return，不重排 nextPollAt
  }

// server.ts:198-202  "Start all" 只捞 paused
const resumed = deps.store.listTargets().filter((t) => t.status === 'paused');

// CourseCard.tsx:19-23  终态是"有意"的
// 'error' and the completed states (registered / waitlisted) are terminal — they cannot be resumed from here.
const PAUSABLE: WatchStatus[] = ['watching'];
const RESUMABLE: WatchStatus[] = ['paused'];
```

- **验证结论：confirmed，维持 high**（我曾把它列为降级候选，逐项核对后否决）：
  1. **"目标永久停摆"成立**：错误状态是持久化的（`updateTarget → save()`），streak 是内存态但无关——重启后 `error` 依旧（`pauseAllWatching` 不碰它）。
  2. **降级理由（"终态是显式设计意图"）不成立**：规范 §5 状态机 `docs/superpowers/specs/2026-06-01-autoregister-design.md:94` 明写 `watching ──操作失败(报错)──► 记录并报告 ──► watching (继续轮询)`，§5 的"终态约定"(:99) 只列 registered/waitlisted；计划 `2026-06-02-p5a-store-scheduler.md:170` 同样写 "on error -> log error; schedule next (keep watching)"。实现改成 3 连击终止是**对设计的有意偏离**，而且偏离时没有配套任何恢复通道。
  3. **触发源包含纯瞬时故障**：3 次 `checkCourse` 抛错（例如一次 Wi-Fi 抖动/探测超时跨越 3 个周期）就能永久摘掉一门课；这不需要用户配置错误。
  4. **日志的补救指引是误导性的**：消息内容让用户 "check the CRN, term, subject, course number and faculty"（:134），而**改对这些字段不会恢复监控**（编辑只 PATCH 查询字段）。
  5. 缓解因素（记录但不降级）：卡片会显示红色 ERROR 徽章、控制台有 error 行，用户并非完全无感；删除+重加是可用的兜底。
- **建议**：保留"error 不再自动重试"的语义，但补一条显式恢复通道（课程卡"重新监控"按钮；或让编辑查询字段时把 `error` 复位为 `watching` 并 `scheduleNext`），并让 start-all 的 `resumed`/跳过数在前端可见。
- **交叉印证/去重**：lane D 的已验证报告以 `[high]` NEW-1 记同一缺陷（根因、影响、建议一致），**汇总时请只计一次**。

### [high] in-flight 守卫只按目标去重，但所有目标共用同一个 Playwright page，手动强制运行会与后台周期互相串页

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:60-62,81-91,219-223,330-338`、`packages/server/src/session/session-manager.ts:39-44`、`packages/server/src/minerva/query-client.ts:21`、`packages/server/src/minerva/register-client.ts:16,39,82`、`packages/server/src/api/server.ts:115-125`、`packages/web/src/components/CourseCard.tsx:29,60-68`、`packages/web/src/pages/Dashboard.tsx:15,87-98`
- **触发路径（已逐跳核实）**：`tick()` 是串行的（:335-337），所以并发只可能来自**手动/强制运行**：用户在目标 B 的卡上点 "Register now" → `POST /api/targets/:id/run`（server.ts:115-125，只要求 B 是 `watching`）→ `scheduler.runTarget(id)`（:219-223，fire-and-forget，仅回 `started:true`）→ `runOnce(B,{force:true})`。`inFlight` 的键是 targetId（:85-89），B 未被占用立即放行；此时若调度器正在为目标 A 跑周期（`checkCourse` 内 9 次 `humanPause()`≈27s 加多次导航，单周期约 30-60s），两条周期都通过 `session.getPage()` 拿到**同一个** Page（`ctx.pages().find(p => !p.isClosed())`，:42）并各自 `goto/selectOption/fill/click/content()`。两条**不同目标**的手动运行（先后点两张卡）同样并发。
- **后果（已核实，并补强）**：交错的导航/取内容会让一方读到另一方的页面（`parseSections` 得到别的课程 → CRN 不在结果 → 记一次失败，3 次后按 A-2 永久停摆），或让 `page.click('input[name="REG_BTN"][value="Submit Changes"]')` 落在被另一方重写过的表单上。**补充一条原文未点明的机制**：Quick Add/Drop 提交的是**整张 worksheet**（register-client.ts:46 往第一个空 `input[name="CRN_IN"]` 填 CRN，:48-51 点 Submit Changes），两条周期共用同一页面时，另一目标的 CRN 可能正躺在同一张表里被一起提交——这正是"最坏提交非预期注册"的现实路径。UI 侧 `runTarget` 是 fire-and-forget、按钮的 `running` 只是本卡的本地标记（Dashboard.tsx:15,88-98），其他卡的按钮**保持可点**（CourseCard.tsx:60-68 只判断本卡 `running`），用户看不到冲突。
- **证据**：

```ts
// scheduler.ts:60-62  守卫粒度是"每个目标"（注释自述只防"同一门课"）
/** Targets with a runOnce currently executing — prevents the tick loop and a
 * manual `runTarget` (or two manual runs) from double-acting the same course. */
private readonly inFlight = new Set<string>();

// session-manager.ts:39-44  全局只有"第一个未关闭的 page"
async getPage(): Promise<Page> {
  const ctx = this.requireContext();
  const existing = ctx.pages().find((p) => !p.isClosed());
  return existing ?? (await ctx.newPage());
}

// query-client.ts:21 / register-client.ts:16,39,82  查询与注册都取同一个 page
const page = await this.session.getPage();
```

- **验证结论：confirmed，维持 high**：不存在任何全局串行化（grep `mutex|lock|queue|semaphore` 在 `packages/server/src` 零命中）；`scheduler.test.ts:326-355` 固化的仅是"同一目标不并发"；Playwright 的 page 级操作队列不是事务，跨周期交错是真实语义。
- **补强证据（同根因，原文未列）**：登录流程也驱动同一个 page——`POST /api/session/login` → `ensureLoggedIn()`（server.ts:162-184 → session-manager.ts:73-108）会 `goto`/点击/反复读取同一个 Page，与在飞周期同样互踩（周期读到登录页 → `parseSections` 空 → 记失败）。因此互斥粒度应当是"浏览器会话"，不只是"运行周期"。
- **建议**：把互斥粒度提升到整个浏览器会话（全局 run 锁/串行队列，手动强制运行**排队**而不是并行），或为每个周期分配独立 Page。
- **交叉印证**：lane D 已把同一守卫的"丢弃无反馈"侧面降级为 low（其验证报告 Downgraded #3），与本条不冲突（本条针对的是跨目标串页，不是丢弃反馈）。

### [medium] 注册预算耗尽时的 ×3 拉伸会波及 notify 目标与 dry-run，把轮询周期无声拉长 3 倍

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:276-279`（配合 `:154-171,185,190,260-283`）、`packages/server/src/api/server.ts:63`、`packages/web/src/pages/Settings.tsx:103`
- **触发路径（已核实）**：×3 分支没有任何 mode/dryRun 判断；`rem.register <= 0 && remainingQuery > 0` 时每次 `scheduleNext`（:145,157,169,177,187,243,248,253 都会调它）都命中。`registerBudget` 设 0 合法（server.ts:63 `min(0)`；Settings 的数字输入框无 `min` 属性），或当天 20 次注册尝试用完后即进入该状态。默认配置（poll=30、jitter=3、queryBudget=100）下，单目标的 `baseMin` 由 30 变成 `max(30*3, 60) = 90` 分钟。
- **后果（已核实）**：notify 模式在 `!opts.force && mode==='notify'` 处就 return（:154-159），dryRun 在 :161-171 return，两条路径都到不了 `budget.recordRegister`（只在 :185/:190 调用）——**它们永不消耗注册预算，却被一起 ×3 减速**。用户把工具设成"只通知/从不自动注册"后，实际检查频率变成配置值的 1/3（与 A-4 的拉伸叠加时可达几十小时），直接表现为更容易错过空位；`scheduleNext` 不产生任何事件（无 `this.log`），用户完全看不到周期被拉长。
- **证据**：

```ts
// scheduler.ts:276-279
// When register budget is exhausted, stretch the interval (can only notify, not act)
if (rem.register <= 0 && remainingQuery > 0) {
  baseMin = Math.max(baseMin * 3, 60); // 3× the query interval, floored at 60 min
}

// server.ts:63  允许 0（= 从不自动注册）
registerBudget: z.number().min(0),
```

- **验证结论：confirmed，维持 medium**。一处表述收紧：注释 "can only notify, not act" 说明 ×3 对 **auto** 目标是**有意**的（注册额度用尽后再高频查询确实无意义），因此缺陷**不是** ×3 本身，而是它缺少 `target.mode === 'auto' && !dryRun` 的守卫，把与注册预算无关的 notify/dry-run 目标一起拖慢。
- **建议**：仅在 `target.mode === 'auto' && !store.getSettings().dryRun` 时应用该拉伸（或直接删掉 ×3，只保留预算摊平）。
- **交叉印证**：lane C（settings/budget）报告涉及同一分支，汇总时注意与 C 的去重。

### [medium] Stop all / Pause 无法中断已经通过状态检查的周期：停止后仍会提交注册并把状态改回 registered

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:93-96,105,121,183,225-256,320-323`、`packages/server/src/api/server.ts:205-210`、`packages/web/src/pages/Dashboard.tsx:69-85`
- **触发路径（已逐跳核实）**：目标 A 处于 `watching`，某次 tick 已把它取出并在 :95-96 校验过状态；随后周期 await `isLoggedIn()`（:105）与 `checkCourse()`（:121，内部 9 次 `humanPause()` 加多次导航，约 30-60s）。用户在这段窗口里点 "Stop all"（server.ts:205-210：watching→paused + `scheduler.stop()`）或课程卡的 "Pause"（Dashboard.tsx:75 只 PATCH status），但 A 的周期**不再重读状态**，继续走到 :183 `actor.act()` 提交注册，最后 `applyOutcome` 把状态写成 `registered`/`waitlisted`（:230/:235），用户刚设的 `paused` 被覆盖。
- **后果（已核实）**：用户在"已经停了"之后仍被注册/候补，停止语义被无声撤销，课程卡从 paused 跳回 registered，只能去 Minerva 退课；`stop()` 只是 `clearInterval`（:320-323），既不取消在飞周期也不等待收尾。
- **证据**：

```ts
// scheduler.ts:93-96  状态只在周期开头读一次
private async runCycle(targetId: string, opts: { force?: boolean }): Promise<void> {
  const target = store.getTarget(targetId);
  if (!target || target.status !== 'watching') return;
  ...
// scheduler.ts:183  决定执行前不再校验状态
outcome = await this.deps.actor.act(target.term, target.targetCrn, action);
```

- **验证结论：confirmed，维持 medium**。行号与引用一致；窗口长度（30-60s）与操作可达性均已核实（Pause/Stop all 按钮在任何时候都可用，不需要与周期互斥）。
- **建议**：`act()` 前重新读取 `store.getTarget(targetId)?.status === 'watching'`（或引入 `stopRequested`/generation 令牌，stop 时递增）；`stop()` 至少标记"取消在飞周期"。
- **交叉印证/去重**：lane D 的已验证报告把它列在"已核实但未单列"第 1 条（medium），**汇总时请只计一次**。

### [medium] `Store.load()` 把任何读取异常都当作"文件损坏"，且备份重命名失败被吞掉后，第一次 `save()` 会覆盖唯一一份数据

- **位置**（已核对）：`packages/server/src/store/store.ts:52-82`（配合 `:84-88`、`:114,153,174`）、`packages/server/src/store/store.test.ts:108-125`
- **触发路径（已核实）**：`try` 块同时包住 `readFileSync` 与 `JSON.parse`（:54-61），因此"文件存在却读不出来"（Windows 上杀毒/同步/备份进程持句柄导致的 EBUSY/EPERM/EACCES）与"内容非法"走同一分支；该分支的兜底是 `renameSync(this.file, corruptPath)`，其自身失败被空 `catch {}` 吞掉（:65-69），此时内存里已是空状态（`targets=[]`、`DEFAULT_SETTINGS`、dailyOps 清零，:76-81）而 `store.json` 仍在原地。用户随后任意一次写操作（`addTarget` :114 / `appendEvent` :153 / `setSettings` :174）都会走 `save()`，无条件 `renameSync(tmp, this.file)`（:87）把这份空状态写回去。
- **后果（已核实）**：全部监控课程、设置（含 SMTP 凭据）与日志被清空，且**没有** `.corrupt` 备份可恢复；UI 只表现为"课程列表空了"，原因只出现在服务端 `console.error`（:70-73）。即便重命名成功，数据也只是被静默搬走，UI 无提示。
- **证据**：

```ts
// store.ts:52-69
private load(): StoreData {
  if (existsSync(this.file)) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
      return { ... };
    } catch (err) {
      // corrupt file — back it up before starting fresh
      const corruptPath = `${this.file}.corrupt`;
      try { renameSync(this.file, corruptPath); }
      catch { /* best-effort backup; if rename fails we still start fresh */ }   // ← 被吞掉
// store.ts:84-88  无条件覆盖
private save(): void {
  const tmp = `${this.file}.tmp`;
  writeFileSync(tmp, JSON.stringify(this.data, null, 2));
  renameSync(tmp, this.file);
}
```

- **验证结论：confirmed，维持 medium**。全部行号与语义核对一致，"读失败与解析失败同分支"、"空 catch"、"save 无条件替换"三点均成立；`store.test.ts:108-125` 说明"损坏→备份→从空开始"是**有意**设计，但它默认重命名会成功，未覆盖读失败/重命名失败。
- **可达性边界（写清，供定级参考）**：无备份的总丢失需要**读失败与备份重命名失败同时发生**（两者都在启动瞬间，同一把锁下会一起失败），之后锁释放、用户的下一次写触发 `save()` 才真正覆盖——因此这条路径是"同一时刻的双故障 + 稍后一次写操作"，不是纯粹的理论可能，但概率取决于环境（本机无法复现，仅代码级确认）。纯解析失败（例如手工改坏 JSON）不会丢数据，会留下 `.corrupt`。
- **建议**：区分"读失败"和"解析失败"（读失败应抛出/拒绝启动并保留原文件）；备份失败时进入只读或终止启动；把损坏/恢复写进事件日志让 UI 可见。

---

## Downgraded（成立但严重度降低）

### [low]（原 medium）`scheduleNext` 的预算拉伸缺少"到本地午夜"的上界：机制成立，但原文的危害示例是被预算决定的公平份额，不是拉伸算错

- **位置**（已核对）：`packages/server/src/scheduler/scheduler.ts:260-283`（配合 `:99-103,288-300`）、`packages/server/src/api/server.ts:58-68,136-144`、`packages/web/src/pages/Settings.tsx:102`
- **已核实的事实**：`pollsPerTarget = remainingQuery / activeCount < 1` 时，`baseMin = minutesUntilMidnight / pollsPerTarget` 确实可以大于"到午夜的分钟数"，代码里**没有任何上界**；原文算术无误（2 门课、remaining=1、正午 720 分钟 → `max(30, 720/0.5) = 1440` 分钟 = 24h）。`scheduleNext` 只在目标自己下一轮周期时被调用，本地午夜没有任何重排钩子；`rescheduleWatching()` 的唯一调用点是 `PUT /api/settings`，且只在 `pollIntervalMinutes`/`jitterMinutes` 变化时触发（server.ts:137-144）——**改 `queryBudget`/`registerBudget` 不会重排**（server.test.ts:341-342 断言了这一行为）。
- **降级理由（关键纠正）**：`minutesUntilMidnight / pollsPerTarget = T·N/R` 正是"把当天剩余额度按课程数摊平到当天剩余时间"的间隔，也就是**公平份额**。原文的示例里 `R=2, N=2` 的公平份额就是每门课每天 1 次（24h），"目标显示 watching 却一整天只轮询一次"是**预算不足的正确结果**，不是拉伸算错；同理 `N=5, R=2` 时拉伸给出 30h 而稳态公平份额是 60h，即它在**多**轮询而非少轮询。真正的越界危害只在 `remainingQuery < activeCount`（当天剩余查询次数少于监控课程数）时才出现，而且那时多轮询就会超预算。默认 `queryBudget=100`（`shared/src/store-types.ts:80`）下，拉伸幅度受限于当天剩余的尾部时段，实测量级是数小时而非一天；一天以上的量级需要"极小预算 + ×3 叠加"，而 ×3 本身是独立的 A-5（且对 auto 目标是有意为之）。
- **仍然成立、值得修的部分（这才是本条保留的价值）**：
  1. 午夜预算重置后没有任何代码重算被拉伸的 `nextPollAt`——目标可以睡过重置点，**新鲜预算空转**（默认量级数小时；极小预算或 ×3 叠加时可达一天以上）；
  2. `PUT /api/settings` 改 `queryBudget`/`registerBudget` 后不调用 `rescheduleWatching()`，用户"把预算调大"的修复动作要等目标自己醒才生效；
  3. "暂停后恢复"同样保留旧的 `nextPollAt`（此变体已由 lane D 的 D-3 覆盖，见去重说明）。
- **最终严重度：low**（可观测性/调度效率缺陷，不是功能失效；且在默认配置下影响被限制在小时级）。
- **建议**：把拉伸结果 clamp 到 `msUntilLocalMidnight(now)`（或本日剩余时间的一个分数），并在 `queryBudget`/`registerBudget` 变化时与 pause→watching 恢复后一并调用 `rescheduleWatching()`。

---

## New（原报告遗漏）

**本次不新增条目（`new = 0`）。** 我在同批文件里另外核实了 5 个候选项，全部要么已被**其它 lane** 覆盖（重复计数比漏报更有害），要么低于 critical/high 门槛：

1. **新增课程默认 `watching` 而引擎未启动 → 主开关显示"监控 · 运行中"却什么都不轮询**（`store.ts:107-115` 默认 `watching`；`server.ts:95-99` 只 `addTarget`，不 `scheduler.start()`；`main.ts:7-16` 启动时只做 `pauseAllWatching()`，全篇无 `start()`；`Dashboard.tsx:103-115,126,140` 用 `anyWatching` 而非 `GET /api/scheduler` 的 `running` 驱动 `SchedulerToggle.tsx:19,24,28`；i18n `scheduler.running='监控 · 运行中'`）。**与 lane D 的 D-1（已验证 high）完全同源**，已在其报告中给出触发路径与建议 → 不重复列。
2. **pause→watching（Start all / Resume）不重算 `nextPollAt`** → 恢复后首轮最长等一整个间隔、预算退避后可能等到次日凌晨。**与 lane D 的 D-3（已验证 medium）同源** → 不重复列（A-4 只保留"拉伸无上界/改预算不重排"这部分）。
3. **`runCycle` 持有 store 里的活对象引用**：`store.getTarget()` 返回数组内对象、`updateTarget` 用 `Object.assign` 原地改（store.ts:95-97,118-124），而查询快照取自 `:111-117`、执行用 `:183` 的实时 `target.term/target.targetCrn`——用户在"查询完成→执行"窗口内改 CRN，会出现"按旧 CRN 的余量决策、对新 CRN 动手"的错配。**lane D 已验证报告已列为 low（未单列第 2 条）** → 不重复列。
4. **`failureStreak` 除 `noteFailure`/`noteSuccess` 外无任何清理点**（grep 全仓仅 scheduler.ts:64,200,202,207,214）：目标失败 2 次 → 用户 Pause → Resume（或改写查询字段）后再失败 1 次即达 3 连击直接进入 `error`。**low**（后果被 A-2 的终态问题吸收，未达新增门槛）。
5. **in-flight 跳过时目标保持"到期"**：`runOnce` 命中 `inFlight` 时只写一条 info 日志并 return（:81-84），不更新 `nextPollAt`，于是该目标保持到期、每 30s tick 重试一次并各写一条事件（每条事件都会触发一次全量 `store.save()` + WS 广播）。在 60s 量级的手动运行窗口内只会多出 1-2 行，**low**，未达门槛。

---

## 原报告自述的"非问题"复核（全部成立，未发现误判）

1. **`msUntilLocalMidnight` 的 DST/本地午夜算术正确** ✔：`new Date(d.getFullYear(), d.getMonth(), d.getDate()+1)`（scheduler.ts:302-306）以本地日期分量取"下一个本地午夜"，23h/25h 的 DST 日自然正确；与 `store.ts:22-28` 的 `localDate`（同用本地分量）以及 `scheduleAfterReset` 的"午夜 +1–6 分钟"（:295-300）语义一致。
2. **`Store.save()` 全同步、单进程无丢更新** ✔：所有写路径（:114,122,128,142,153,164,174,200,206）都是同步 `writeFileSync` + `renameSync`，Node 单线程下不存在交错窗口；`getDailyOps` 是纯读（:183-189）。
3. **长跑内存无达到门槛的增长** ✔：`events` 上限 2000（:13,150-152）；`inFlight` 严格成对 add/finally-delete（:85-90）；`failureStreak` 规模上界为课程数（但见上文关于"无清理点"的 low 观察）。

---

## 跨 lane 去重提示（供汇总）

| 本条                                         | 与其它 lane 的关系                                   | 汇总建议                                            |
| -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| A-2 error 死状态（high）                     | = lane D 已验证报告 NEW-1（high）                    | 只计一次                                            |
| A-6 stop/pause 不中断在飞周期（medium）      | = lane D 已验证报告"已核实但未单列"第 1 条（medium） | 只计一次                                            |
| A-4 的"恢复不重算 nextPollAt"变体（low）     | = lane D 已验证报告 D-3（medium）                    | 该变体归 D-3；A-4 只保留"无午夜上界 + 改预算不重排" |
| new 候选 1（加课默认 watching / 引擎未启动） | = lane D D-1（high）                                 | 不重复列                                            |
| new 候选 3（runCycle 活引用）                | = lane D 未单列第 2 条（low）                        | 不重复列                                            |
| A-5 ×3 拉伸（medium）                        | 与 lane C（settings/budget）同一代码分支             | 汇总时核对是否重复                                  |
