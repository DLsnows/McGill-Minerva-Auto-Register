# F · 前端健壮性与测试缺口 — 对抗性验证后报告

> 验证者：对抗性审计（独立打开每一条发现引用的文件/行号复核）
> 目标仓库（只读，未改动任何文件）：`C:/Users/lenovo/deepseekHarness/Auto-Register/wt/audit`
> 原始报告：`audit-findings/F-frontend-tests.md`（10 条发现）

## 验证方法

对原报告 10 条发现逐条独立复核：读取被引用的源文件与行号、追踪真实调用路径、检查上游守卫与 else 分支、对照设计文档（`docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md` §5/§6/§7）确认是否为已声明的设计意图，并检查服务端实现以判断影响链是否真的成立。

**结论概览**：`confirmed` 1 条 · `downgraded` 8 条 · `refuted` 0 条 · `new` 1 条（low）。

原报告的**主线判断成立**：会话状态与实时数据确实只在挂载时拉一次、刷新依赖 Dashboard 事件流、`resource.error` 无任何消费者。但原报告在若干处**夸大或误读了语义**，最具代表性的是：

1. **"重连后不刷新"不成立**——服务端在每次 WS 建连时立即推送 `recent` 快照（`server.ts:240`），快照会改变 `events` 数组并让 `lastEventId` 变化，从而在 Dashboard 挂载时触发 refetch。真正缺失的是**非 Dashboard 路由**（组件卸载即断连）与 **session 资源永不重拉**。
2. **"dry-run 完全不可见"不成立**——`scheduler.ts:161-171` 在每次命中空位时都会写一行 `DRY-RUN: would REGISTER …`，紧跟在 `Opening found (REGISTER)` 之后出现在实时控制台里。它是**可见的**，只是没有常驻标识。
3. **"清空数字输入静默变 0"只对 `registerBudget` 成立**——设计文档 §6 的邮箱校验确实**遗漏了 port 整数校验**（仅判真值即放行 99999/-1/0.5），但 `pollIntervalMinutes`/`queryBudget` 的 0 值会被服务端 400 拦下，不是"静默"。

同时，原报告**遗漏了一条自己亲手可验证的 pacing 缺口**：一键执行入口没有节流或服务端冷却，可绕过 `nextPollAt` 节奏（见 NEW-1）。

---

## Confirmed（证据成立，严重度维持）

### [high] 会话状态只在启动时拉取一次，永不重新校验，UI 可长期谎报「已登录 / Active」

- **location**：`packages/web/src/lib/DataContext.tsx:19`
- **trigger**：打开控制台并登录成功后长期挂着页面；此后 Minerva 会话自然过期，或按 UI 自己的提示在别处登录（`i18n/index.ts:67` 明写"logging in elsewhere will evict the automation"）。调度器检测到登出后会把该 target 置为 `paused`（`scheduler.ts:105-108`）。前端再无任何代码调用 `GET /api/session`，除非重新走一次登录流程（此时最多轮询 6 分钟）或整页刷新。
- **impact**：Ticker 会话点持续绿灯 `Active`、Session 页持续显示「Authenticated — automation can run」、Dashboard 的「会话未激活」横幅永不出现（`Dashboard.tsx:128-133` 判的是 `session.data.status`）；用户在自动化其实已被服务端 `paused` 的错觉下错过抢课窗口。这是本次审计中**唯一**一条"核心功能静默失效 + UI 主动误导"的路径。
- **evidence**：
  - `DataContext.tsx:19` `const session = useResource(() => api.getSession());` — `useResource` 只在挂载时执行一次（`useResource.ts:51-53`），而 `DataProvider` 挂在 `main.tsx:12` 的根部，整个会话生命周期内不会重新挂载（路由切换只重挂 `<Outlet/>`）。
  - 全仓 grep `session.refetch` 仅命中 `Session.tsx:63`（登录按钮内）与测试文件；`Session.tsx:41-55` 的轮询 `if (status !== 'logging-in') { setCapped(false); return; }` 在 `authenticated` 后立即停止。
  - `server.ts:149-161` 的 `GET /api/session` 内部确有懒校验（会调 `deps.session.isLoggedIn()`），即**服务端已经准备好了这个能力，客户端从不使用**。
- **suggestion**：给 session 资源加**事件驱动**刷新（收到 `warn`/`error` 级别事件时 `session.refetch()`），并提供一个不主动探测 Minerva 的本地会话快照端点供轮询。
  **重要修正**：不建议按原报告"60-120s 低频轮询 `GET /api/session`"——服务端 `isLoggedIn()` 会真实导航浏览器到受保护页面（`session-manager.ts:56-65` `checkStatus()` → `page.goto(PROTECTED_PROBE_URL)`），轮询它等于每 1-2 分钟主动请求一次 Minerva，直接违反本项目自己的 pacing 设计（`i18n/index.ts:55`：「有助于避免被 McGill 服务器判定为异常 / 机器人行为，进而被限流或锁定账号」）。原报告的建议会造成比它要修的问题更严重的账号风险。

---

## Downgraded（成立但严重度降低）

### [medium]（原 high）所有资源错误被吞掉：加载失败被渲染成空态/加载中/默认预算，无重试入口

- **location**：`packages/web/src/lib/useResource.ts:16-18`（错误仅被写入 state，见 `44-45`）
- **降级理由**：原报告的证据链全部成立，但严重度被高估——影响是**用户可见、可自行恢复**的（整页刷新即复位），且只在"后端重启 / 首次打开时后端未就绪"这类瞬时窗口内发生；`Settings` 卡在「加载设置中…」是唯一需要重新加载页面才能脱困的形态，不是数据损坏。原报告"用户以为配置被清空而重加 → 产生重复 target"的推演成立（`store.ts:99-116` 的 `addTarget` 确实无去重，`server.ts:95-99` 也不查重），但后果只是多一条卡片，不是丢数据。
- **trigger**：后端重启、5xx 或首次打开时后端未就绪，导致 `getTargets`/`getSettings`/`getBudget` 任一失败。
- **impact**：`Settings` 页永久停在「加载设置中…」且无错误无重试（`Settings.tsx:68 if (!form) return <div className="empty">{t('settings.loading')}</div>`，`form` 只在 `settings.data` 到达时被赋值）；`Dashboard.tsx:125,148` 与 `Courses.tsx:14,61` 把失败渲染成「还没有监控任何课程 / 暂无课程」；Ticker 静默使用默认 100/20 预算或显示 `0 / 100`（`App.tsx:40-43`：`budget.data?.query ?? queryBudget` 在数据缺失时使 `queryUsed` 为 0）。三处均违反设计文档 §6「REST 失败要有行内错误条」。
- **evidence**：`useResource.ts:44-45` 写入 error、`:57` 把 error 对外暴露，但全仓 grep `.error` 在 `src` 下**只命中 `useResource.test.tsx` 与 StatusBadge 的样式键**，无任何渲染消费者；`Settings.tsx:68`、`Dashboard.tsx:125/148`、`Courses.tsx:14/61` 均未在空态前判 `loading`/`error`。
- **suggestion**：消费者侧统一补错误条 + 重试按钮，空态渲染前先判 loading/error；Ticker 在 settings/budget 出错时显示占位符而非默认预算。

### [medium]（原 medium）实时刷新链路只存在于 Dashboard 路由，断线/重连后不重拉的说法部分不成立，Ticker 与共享数据在非 Dashboard 路由静默冻结

- **location**：`packages/web/src/pages/Dashboard.tsx:14`
- **修正记录（原报告的重要误读）**：原报告称"重连后要等下一个事件才刷新，或永远不来"。**该说法不成立**：`server.ts:235-246` 在每次 WS 建连后立即 `socket.send({type:'recent', events: …})`，`useEventStream.ts:40` 用快照 `setEvents(cap(msg.events))` 替换数组，这会让 `Dashboard.tsx:38` 的 `lastEventId` 发生变化并触发 `39-43` 的 refetch。**只要 Dashboard 处于挂载状态，重连就等价于自动重拉一次 targets+budget。** 同理"WS 掉线时 Ticker 会话点变灰"确实**未实现**（Ticker 只收 `sessionStatus`，不收 `connected`，`Ticker.tsx:4-13` 无 `connected` prop），但这是设计 §6 与实现之间的差距，不构成"静默冻结"的独立放大项。
- **由此收敛后的真实缺口**：非 Dashboard 路由（Courses / Session / Settings）上 Dashboard 卸载 → WS 关闭 → **全应用再无任何轮询**，Ticker 的 `watching`/今日查询/今日注册/会话点全部冻结；且 `session` 资源**在任何路由都不会被事件流刷新**（`Dashboard.tsx:41-42` 只 refetch budget 与 targets）。
- **trigger**：切到课程/会话/设置页停留；或停在 Dashboard 但发生不产生事件的状态变化（本地午夜预算重置——`scheduleAfterReset` 只是重排 `nextPollAt`，`store.getDailyOps` 的跨日归零是纯读路径 `budget.ts:23-30`，不发事件；另一标签页改了设置；WS 掉线后重连成功——后者仅对非 Dashboard 路由成立）。
- **impact**：用户误判「自动化一次都没跑」；真实后果比"数字不刷新"更重的是：**调度器因会话失效把 target 置为 `paused`（`scheduler.ts:105-108`）时，若用户不在 Dashboard，卡片会一直显示 `WATCHING`**，直到用户碰巧回到 Dashboard 触发一次 refetch——"课程已停止被监控"这件事在 UI 上无任何主动告知。此外 `nextPollAt` 已随 `/api/targets` 下发（`shared/src/store-types.ts:22`，服务端 `scheduler.ts:282` 写入），`fmtCountdown` 有实现有测试却**无任何 UI 调用点**。
- **evidence**：`Dashboard.tsx:14` `const { events, connected, clear } = useEventStream();`（全仓唯一调用点，卸载即 `ws.close()`）；`useEventStream.ts:28-31,47-52`（`onopen` 只重置退避与 `connected`，不触发 refetch）；`Dashboard.tsx:39-43`（只在 `lastEventId` 变化时 refetch budget+targets）；grep `fmtCountdown` 仅命中 `format.ts:12` 与 `format.test.ts`；grep `nextPollAt` 在 `packages/web` 下 **0 命中**。
- **suggestion**：把 `useEventStream` 提升到 DataProvider/Shell 层保活（顺带解决 Ticker 掉线灰点的设计缺口），并在 Dashboard 的 refetch 里补上 `sessionRef.current.refetch()`；Ticker 增加数据新鲜度或下次轮询提示。

### [medium]（原 medium）数字设置项缺范围校验：`registerBudget` 清空静默变 0 并静默停掉当天全部注册；越界值把原始 zod JSON 甩到界面

- **location**：`packages/web/src/pages/Settings.tsx:19-32`
- **修正记录（原报告此处有一处语义误读）**：原报告把"清空轮询间隔/查询预算"也归入"静默"。实际**不静默**：`pollIntervalMinutes: z.number().min(1)` 与 `queryBudget: z.number().min(1)` 会返回 400（`server.ts:60-63`），只有 `registerBudget: z.number().min(0)` **接受 0**。所以真正的"静默失效"只有注册预算一项；另一条独立缺口是邮箱校验，见下。
- **trigger**：
  1. 清空「每日注册预算」后直接保存：`Number('') === 0`，服务端 `min(0)` 放行，静默存成 0。
  2. SMTP 端口填 `99999`/`-1`/`0.5`：`emailComplete` 只判真值（`Settings.tsx:70`），三者全部为真值 → 前端放行 → 服务端 `emailSchema`（`server.ts:50-56`，`int().min(1).max(65535)`）返回 400。设计 §6 明确要求"port 为合法整数，保存前拦截"，实现未做。
- **impact**：注册预算存成 0 → `budget.canRegister()` 恒 false（`budget.ts:11-13`）→ 调度器在命中空位时只打一行 `'Daily register budget reached — will retry next cycle'`（`scheduler.ts:174-179`）并跳过，当天所有真实注册被跳过，且该文案在预算**从未被用掉**时是误导性的；Ticker 显示 `0 / 0`。越界值场景则是界面直接出现 `PUT /api/settings failed: 400 — {"error":{"formErrors":[],"fieldErrors":{...}}}`（`api.ts:18-26` 原样拼接 `res.text()`，`server.ts:131` 发送 `parsed.error.flatten()`）而非字段级提示。
- **evidence**：`Settings.tsx:28` `onChange={(e) => onChange(Number(e.target.value))}`（`Number('') === 0`）；`NumField` 未设 `min/max/step`；`Settings.tsx:70` 的 `emailComplete` 对 port 只做真值判断；`Settings.tsx:144` 的 port 走 `TextField` + `Number(s)`，同样无整数校验；`server.ts:58-68` 的 `settingsSchema` 确为 `.partial()`，但被赋值的键仍走各自的 `min/max`。
- **suggestion**：给 `NumField` 加 `min/max/step`，空串单独处理（不要 `Number('')`）；保存前按服务端同款约束做字段级校验（含 port 整数），并把 `error.fieldErrors` 映射成字段旁提示而不是原始 JSON。

### [low]（原 medium）dry-run 演练模式在 Settings 之外无常驻标识——但"完全不可见"的论据不成立

- **location**：`packages/web/src/pages/Settings.tsx:122-132`
- **降级理由**：原报告的证据句"grep dryRun 只命中 i18n 与 Settings 页 … 控制台滚动 'Opening found (REGISTER)' … 与真实抢课表现几乎一致"**与代码不符**。`scheduler.ts:161-171` 在 dry-run 下每个命中空位的周期都会额外写一条 `DRY-RUN: would ${action} ${target.targetCrn} — …` 并广播到事件流，紧跟 `scheduler.ts:149` 的 `Opening found (… )` 之后出现在实时控制台里（`ok`/`action` 级着色）。也就是说该状态**在 Dashboard 上逐次可见**，只是没有常驻标识、卡片仍显示 `WATCHING`、且开关本身在 Settings 页底部易被遗忘。据此从 medium 降为 low。
- **trigger**：用户为试跑打开「Dry-run（演练）模式」后忘记关闭，继续 Start all 并放任控制台运行数天；期间不去看 Dashboard 控制台。
- **impact**：命中空位时只记一行日志就返回，永不真正注册/候补，target 永不进入 `registered`；Shell、Ticker、卡片、徽章均无任何标识（grep `dryRun` 在 `packages/web/src` 下只命中 `i18n/index.ts` 与 `Settings.tsx`）。用户在长时间不观察控制台的情况下仍可能误判。
- **evidence**：`Settings.tsx:124-130`（全应用唯一开关）；`scheduler.ts:161-171`（dry-run 早返回）；`scheduler.ts:149-152`（`Opening found` 与 DRY-RUN 行相邻输出）。
- **suggestion**：dryRun 为真时在 Shell 常驻醒目 banner/徽标，并在开启时二次确认。

### [low]（原 medium）切换 mode / 一键执行失败时无 try/catch；忽略 `{started:false}`——但"用户误以为已强制抢课一轮"的路径几乎不可达

- **location**：`packages/web/src/pages/Dashboard.tsx:87-98`
- **降级理由**：原报告把"用户误以为已强制抢课一轮"当作主要影响。核对 UI 守卫后发现该路径需要**竞态**才可达：`CourseCard.tsx:29,63` 让「⚡ Register now」在 `target.status !== 'watching'` 或 `!loggedIn` 时 `disabled`，而服务端返回 `{started:false}` 的条件恰是 `status !== 'watching'`（`server.ts:120-122`）；只有在客户端那份 target 已过期（服务端上一轮因会话失效把它置为 `paused`）而用户恰好在此瞬间点击时才成立。真实且容易触达的部分是 `onToggleMode` 的未处理 rejection。两条合并后降为 low。
- **trigger**：点卡片开关而 PATCH 失败（后端刚重启）→ `await api.updateTarget` 无 catch，未处理 rejection，开关由 `target.mode` 驱动而属性未变，视觉上"点了没反应"，用户反复点击；或点「Register now」时该 target 在服务端已不是 `watching`。
- **impact**：两种失败都没有任何用户可见反馈（`schedErr` 只覆盖 `onTogglePolling` / `onToggleScheduler`）；`onRun` 用 `finally` 清掉 `running` 却无视响应体，`{started:false, reason:'target is paused'}` 被当作成功，按钮闪一下「… running」即恢复。
- **evidence**：`Dashboard.tsx:45-48`（`await api.updateTarget(id, { mode: next }); await targetsRef.current.refetch();` 无 catch）；`Dashboard.tsx:87-98`（`try { await api.runTarget(id); } finally { … }` 不读返回值）；`api.ts:49` 返回类型 `{ started: boolean }` 被丢弃；对照 `Dashboard.tsx:69-85` 的 `onTogglePolling` 有完整 try/catch + `finally` 重拉，可见这是遗漏而非设计。
- **suggestion**：两个回调补 catch → `setSchedErr(...)`，并在 `started === false` 时提示 `reason` 后立即 refetch targets。

### [low]（原 low）i18n 残留：卡片「上次轮询」的相对时间是硬编码英文

- **location**：`packages/web/src/lib/format.ts:19-25`
- **trigger**：切到中文或法文后查看任意课程卡片底部的「上次轮询」。
- **impact**：得到混排文案「上次轮询 5m ago」「dernier sondage 2h ago」。
- **evidence**：`format.ts:21-25` 直接返回 `'just now'` / `'${s}s ago'` / `'${m}m ago'` / `'${h}h ago'`；`CourseCard.tsx:73` 把它作为 `{{rel}}` 插值进已翻译的模板。复核原报告"这是三语字典里唯一的不一致"：我用 `>[^<>{]*[A-Za-z]{3,}[^<>{]*<` 扫描 `packages/web/src` 全部非测试 `.tsx/.ts`，未发现其它未被 `t()`/`tr()` 包裹的用户可见文案，该结论成立。
- **suggestion**：让 `fmtRelative` 返回结构化的 `{unit,value}`，或把 `justNow/Minutes/Hours` 词条交给 i18next 插值。

### [low]（原 low）语言切换后 `<html lang>` 仍是 en，语言控件当前项也未暴露给辅助技术

- **location**：`packages/web/index.html:2`
- **trigger**：顶部切换语言为 中文/FR 后用读屏软件阅读页面，或触发浏览器翻译/断词。
- **impact**：文档语言始终声明为英语，读屏用英文语音规则读中文/法文；当前语言仅由 CSS class `pill-on` 表示（`LanguageSwitcher.tsx:19`），无 `aria-pressed`/`aria-current`，容器标签还是硬编码英文 `aria-label="language"`（`LanguageSwitcher.tsx:14`）。
- **evidence**：`index.html:2` `<html lang="en">`；`i18n/index.ts:222-229` 的 `setLang` 只做 `changeLanguage` + localStorage，不碰 `documentElement.lang`；全仓无 `documentElement.lang` 写入点。
- **suggestion**：在 `setLang`/`languageChanged` 中同步 `document.documentElement.lang = lng`；语言按钮加 `aria-pressed`，容器标签走 i18n。

### [low]（原 low）实时控制台无 aria-live，新日志与「已注册」等关键行对读屏用户静默

- **location**：`packages/web/src/components/Console.tsx:50-56`
- **trigger**：用读屏软件停在页面等待自动化结果（候补成功/注册成功/报错）。
- **impact**：日志容器只是普通 `div.log`，无 `role="log"`/`aria-live`，新到的 `ok`/`error` 行不播报；反而连接状态行有 `role="status"`（`Console.tsx:41`），用户能听到「重连中…」却听不到「Registered COMP 551!」。
- **evidence**：`Console.tsx:50-52` `<div className="log" ref={logRef}>{ordered.map(…)}`，无任何 ARIA live 属性；`Console.tsx:41` 的 `role="status"` 对比鲜明。
- **suggestion**：给日志容器加 `role="log"` + `aria-live="polite"`（错误可 assertive），必要时 `aria-relevant="additions"`。

### [low]（原 low）关键路径测试缺口：重连退避、App 壳预算换算、初始加载失败均无测试

- **location**：`packages/web/src/lib/useEventStream.test.tsx:58-64`
- **trigger**：任何一次改动后的 `npm run test` 全绿；这些路径从未被验证。
- **impact**（逐条复核结论）：
  1. **属实**——设计 §7 要求验证「快照→增量、重连退避」，但测试只断言 `onclose` 后 `connected=false`；退避 `setTimeout`（`useEventStream.ts:50-51`）、重连后 `recent` 重播种、卸载 `clearTimeout`（`:56-60`）全无覆盖；`FakeWS` 连 `onerror` 都没有，`useEventStream.ts:43-46` 的 CSP 分支从未执行。
  2. **属实**——`packages/web/src` 下无 `App.test.tsx`（grep `App` 于 `*.test.tsx` 零命中），`App.tsx:40-43` 的 `queryBudget - (budget.data?.query ?? queryBudget)` 与 100/20 默认值无断言；`Ticker.test.tsx:8-17` 只喂字面量 props。
  3. **属实**——无任何用例让 `getTargets`/`getSettings` reject（各页测试的 `mockAll()` 全部 `mockResolvedValue`），因此错误被吞成空态/永久「加载中」不会被发现。**附带发现**：`Dashboard.test.tsx:16-25` 的 `mockApi` 未 mock `getSettings`/`getScheduler`，而 `DataProvider` 会拉这两个端点，于是测试里真实 `fetch` 被调用并 reject（仅因 `useResource` 内部 catch 才没炸掉用例）——这本身就说明该测试套件对加载失败路径是"瞎"的。
  4. **属实**——`fmtCountdown` 有完整测试（`format.test.ts:10-13`）却无 UI 调用点，真正显示的数字与文案没有端到端断言。
- **evidence**：`useEventStream.test.tsx:58-64`；`App.tsx:40-42`；`Dashboard.test.tsx:8-14`（`vi.mock('../lib/useEventStream')`，所以真实的退避/重播种逻辑在页面测试里也被整体旁路）。
- **suggestion**：补三类用例：fake timers 推进重连退避并断言第二次 `new WebSocket`；新建 `App.test.tsx` 覆盖 Ticker 数值与失败回退；各页补「初次加载 reject → 错误条 + 可重试」用例。

---

## New（原报告遗漏，本次亲手验证）

### [low] 一键执行缺少节流/冷却：连点「⚡ Register now」可绕过 `nextPollAt` 节奏，把每日查询预算烧在手动触发上

- **location**：`packages/web/src/pages/Dashboard.tsx:87-98`（配合 `packages/server/src/api/server.ts:115-125`）
- **trigger**：用户连点「⚡ Register now」。按钮的 `running` 状态只覆盖 POST 请求在途的瞬间（`server.ts:115-125` 的"接受"是同步快速返回的，真正的查询/决策/注册异步进行），POST 一返回按钮立刻恢复可点。
- **impact**：与自动轮询不同，手动执行**不经过** `nextPollAt` 节流（`scheduler.ts:329-338` 的 `tick()` 只跑 `nextPollAt` 到期的 target，而 `/run` 直接调 `deps.scheduler.runTarget(id)` → `runOnce` 忽略 `nextPollAt`）。唯一的节流是每个 target 的 in-flight 守卫（`scheduler.ts:80-91`，并发重复点击只会记一行 `Run already in progress` 并跳过），因此**串行连点仍会逐次真实查询 Minerva**，唯一硬约束是每日查询预算（`scheduler.ts:99-103`）。这与本项目反复强调的 pacing 意图相冲突（`i18n/index.ts:55`：抖动与低轮询频率是为了"避免被 McGill 服务器判定为异常 / 机器人行为，进而被限流或锁定账号"）。评为 low 而非 high：仅本地单用户、需要用户主动连点、且有 in-flight 守卫与每日预算兜底，危害是"预算被提前烧掉"而非账号风险。
- **evidence**：`Dashboard.tsx:87-98`（无客户端节流、不读响应体）；`api.ts:49` `runTarget` 为无体 POST；`server.ts:119-124`（只在 `status !== 'watching'` 时拒绝，无冷却时间检查）；`scheduler.ts:80-91`（`runOnce` 的 in-flight 守卫）；`scheduler.ts:329-338`（`tick()` 才有 `nextPollAt` 判断）；`scheduler.ts:99-103`（唯一预算守卫）。
- **suggestion**：给「Register now」加客户端冷却（如该 target 上一轮结束前二次确认）或在服务端 `/api/targets/:id/run` 记录 `lastForcedRunAt`，冷却期内返回 `{started:false, reason:'cooldown'}`；同时让 `running` 状态跟随事件流里该 target 的周期结束事件而非 POST 返回。

---

## 附：被证伪的具体断言（不单独成条，供交叉核对）

| 原报告断言                                                                   | 复核结果                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「重连后要等下一个事件才刷新（可能整整一个轮询间隔，或永远不来）」           | **不成立**（Dashboard 挂载时）。`server.ts:240` 建连即推 `recent` 快照 → `useEventStream.ts:40` 替换数组 → `Dashboard.tsx:38-43` 的 `lastEventId` 变化 → 触发 refetch。缺口只在非 Dashboard 路由与 session 资源。 |
| 「dry-run … 与真实抢课表现几乎一致 / 控制台滚动 'Opening found (REGISTER)'」 | **不成立**。`scheduler.ts:163-168` 每个命中周期都额外输出 `DRY-RUN: would REGISTER <CRN> — <reason>`，与 `Opening found` 相邻可见。                                                                               |
| 「清空『轮询间隔』或『每日查询预算』后保存」被归入"静默变 0"                 | **部分不成立**。这两项服务端 `.min(1)` 会 400；静默被接受的只有 `registerBudget`（`.min(0)`）。                                                                                                                   |
| 「用户误以为已强制抢课一轮」（`started:false` 被当成成功）                   | **可达性极低**。`CourseCard.tsx:29,63` 在非 `watching`/未登录时禁用按钮，需竞态才可点。                                                                                                                           |
| 「ticker 显示 0/100」                                                        | **成立**，`App.tsx:40` 在 `budget.data` 缺失时 `queryUsed = queryBudget - queryBudget = 0`。                                                                                                                      |
| 「三语字典键集合由类型锁死」                                                 | **成立**，`i18n/index.ts:71,135` 以 `const zh: typeof en` / `const fr: typeof en` 声明，键集合与 `{{j}}`/`{{rel}}` 插值三语一致（`minSuffix`/`lastPoll` 均带同名占位符）。                                        |
