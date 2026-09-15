# C 设置与预算展示一致性（对抗性验证版）

> **验证对象**：`audit-findings/C-settings-budget-ui.md`（原报告 6 条发现，1×high / 3×medium / 2×low）
> **验证方式**：只读打开每条发现引用的文件与行号，独立重放触发路径；用 grep 交叉验证全称断言（"全局唯一 budget 刷新点"、"全前端无消费者读 `resource.error`"）；并对照上游 zod 校验、`store.setSettings` 的合并语义、以及源码注释与设计文档中的显式意图。
> **判定结果**：**6 条发现全部成立（0 条证伪）；其中 2 条的严重度被夸大，降级为 low（C3、C4）；4 条维持原判**。行号引用逐条核对无误（`App.tsx:14/40-43`、`Ticker.tsx:40`、`Settings.tsx:28/62-68/83-85/156`、`Dashboard.tsx:38-43`、`useResource.ts:34-53`、`server.ts:129-146/226`、`budget.ts:23-30`、`store.ts:172-176`、`scheduler.ts:99-103/174-179/258-292`、`api.ts:18-26/52-57`、`main.ts:12`）。
> **唯一被推翻的"子论断"**：C2 变体 C 的措辞「误报『已保存 ✓』」——PUT 确实已持久化，徽标本身没有说谎，真正的问题只是显示未随服务端刷新。整体发现仍成立，故 C2 计为 confirmed（medium），不计 refuted。
> **新增条目**：0。在本 lane 的相关文件里我另外核查了"更严重"的若干方向（预算守卫是否可被绕过、settings 表单能否静默改写 `dryRun`、`/api/settings` 是否泄露 SMTP 口令、`DataProvider` 是否漏挂、数值输入能否造成服务端状态损坏），未发现达到 critical/high 且本报告漏掉的问题（`/api/settings` 明文回传 SMTP 口令已由 lane E 收录，不在此重复计入）。

---

## 发现

### [high] ticker 的「已用/上限」由 settings 与 budget 两个快照拼接而成，保存设置后 budget 不刷新，立刻渲染出伪造进度（报障1 根因）——**confirmed（维持 high）**

- **位置**: packages/web/src/App.tsx:40（配套 41-43、14-15）；packages/web/src/pages/Settings.tsx:83-84；packages/web/src/pages/Dashboard.tsx:38-43；packages/server/src/api/server.ts:226；packages/server/src/budget/budget.ts:23-30
- **触发路径（已逐条复现）**:
  1. 当天 0 次查询，store 里 `queryBudget = 1000`（`packages/server/src/api/main.ts:12` 启动时把所有 watching 目标暂停，所以确实是 0）。
  2. 打开控制台：`DataContext.tsx:18-22` 并发拉 5 个资源，settle 后 `settings.data.queryBudget = 1000`、`budget.data = {query: 1000, register: 20}`（`budget.ts:27`）→ ticker 显示 `0 / 1000`（`App.tsx:40`：`1000 - 1000 = 0`）。
  3. 进「设置」页把「每日查询预算」（`i18n/index.ts:110`）从 1000 改成 10000，点「保存设置」。
  4. `Settings.tsx:83` 发 `PUT /api/settings`（服务端确实已持久化 10000，`server.ts:141` → `store.ts:173`），紧接着 `Settings.tsx:84` 只 `await settings.refetch()`。**grep 确认全前端只有 `Dashboard.tsx:41` 一处 refetch budget**，且它只在事件流到达且 Dashboard 已挂载时才跑；设置页上没有任何代码刷新 budget。
  5. 重新渲染：`App.tsx:14` `queryBudget = 10000`；`App.tsx:40` `queryUsed = 10000 - 1000 = 9000`；`Ticker.tsx:40` 原样输出 → **`9000 / 10000`**。只要用户还停在设置页（或任何非 Dashboard 页面），这个错误值就会一直留着。
  6. 负值路径：同一个算式在"分子分母来自反方向快照"时给出负数，`Ticker.tsx:40` 无 clamp。原报告只举了"settings 旧、budget 新"（另一标签页 / 首屏 settings GET 慢而走兜底 100 → `-9000 / 1000`、`-9900 / 100`）；**我另外确认了一条更短的单标签页路径**：把预算下调到低于当前 stale remaining 即可，例如今天已查 5 次、客户端最后一次拿到的 `budget.data.query = 995`，用户把上限从 1000 改成 100 → `100 - 995 = -895` → 渲染 `-895 / 100`。既不需要第二个标签页，也不需要请求失败。
  7. 自愈时机（校正）：`useEventStream.ts:40` 会在 WS 连上时用服务端 `server.ts:240` 推送的 `{type:'recent'}` 快照**重新播种** `events`，所以"切回 Dashboard 且 store 中日志非空"时 `Dashboard.tsx:39-43` 会立即 refetch，而不是"必须等第一条新事件"；只有日志被清空且没有新事件时才会一直错下去。这不改变缺陷本身，但解释了报障里"开始轮询之后就正常了"。
- **后果（校正后）**: 应用最显眼的「今日查询/注册」进度在用户刚改完上限时是**确定性的伪造值**（把旧上限当成已用次数），会直接误导用户判断当天还剩多少配额；同一缺陷对注册预算同样成立（`App.tsx:42`：20→200 时显示 `180 / 200`）。影响面仅限展示层——`budget.ts:7-13` 的 `canQuery/canRegister` 与 ticker 无关，服务端守卫不受污染——但这是用户唯一能看到的配额信息，且是报障1 的直接根因，维持 high。
- **证据**:
  ```tsx
  // packages/web/src/App.tsx:13-15, 40-43
  const s = settings.data;
  const queryBudget = s?.queryBudget ?? 100;
  const registerBudget = s?.registerBudget ?? 20;
  ...
  queryUsed={queryBudget - (budget.data?.query ?? queryBudget)}   // L(新) - R(旧快照)
  queryBudget={queryBudget}
  registerUsed={registerBudget - (budget.data?.register ?? registerBudget)}
  ```
  ```ts
  // packages/server/src/budget/budget.ts:23-29 —— 只返回"剩余量"，且被 clamp 在 >= 0
  remaining(now = Date.now()): { query: number; register: number } {
    const ops = this.store.getDailyOps(now);
    const s = this.store.getSettings();
    return {
      query: Math.max(0, s.queryBudget - ops.queryCount),
      register: Math.max(0, s.registerBudget - ops.registerCount),
    };
  }
  ```
  ```ts
  // packages/web/src/pages/Settings.tsx:83-85 —— 保存后只刷新 settings
  await api.putSettings({ ...form, email: form.notify.email || emailComplete ? email : undefined });
  await settings.refetch();
  setSaved(true);
  ```
  ```tsx
  // packages/web/src/components/Ticker.tsx:39-41 —— 裸插值，无 clamp／无剩余量语义
  {p.queryUsed} / {p.queryBudget}
  ```
- **验证备注**: 原报告"字面 `9000 / 1000` 在数学上不可能"的推理成立（`used = L - R`、`Ticker` 的分子分母同源于同一次渲染的 L，`budget.ts:27` 又保证 R ≥ 0），负值方向也确实可达。唯一需要修正的是第 6、7 步的表述（见上）。**severity 核验**：触发是确定性的、不需要任何异常条件，用户可见的核心状态被判错，维持 high；不升级为 critical 是因为它不改变任何服务端状态、也不影响预算执行。
- **建议**: 让 `GET /api/budget` 在同一个 handler 里读一次 settings + 一次 dailyOps，返回原子快照 `{ used, limit, remaining }`，ticker 只展示该对象并删除 `App.tsx:40/42` 的减法拼接；保存设置成功后同时 `await Promise.all([settings.refetch(), budget.refetch()])`（`Settings.tsx:83` 已经拿到了 PUT 的返回值，也可直接用它更新 `settings` 资源）。

### [medium] useResource 吞掉失败且从不重试、前端也不渲染 resource.error：一次失败的 GET 会长期污染 ticker，并让设置页卡在加载态——**confirmed（维持 medium，修正一处子论断）**

- **位置**: packages/web/src/lib/useResource.ts:34-49（错误只写进 state 且不 rethrow、无重试）；packages/web/src/pages/Settings.tsx:61-68、84-85；packages/web/src/App.tsx:14-15
- **触发路径**: 服务端忙/被代理挡一次，`GET /api/settings` 失败（或 502 返回 HTML 触发 `api.ts:21-24` 抛错）。`useResource` 只 `setError`，挂载 effect（`useResource.ts:51-53`，依赖是稳定的 `refetch`）不会重跑，**grep 全 `packages/web/src` 确认没有一处读 `resource.error`**（只命中 `useResource.test.tsx`）。于是 `settings.data` 在本次 SPA 会话内永远是 `undefined`。
  - 变体 A（设置页）：`Settings.tsx:68` 的 `if (!form)` 依赖 `settings.data`（`Settings.tsx:62`），页面停在「加载设置中…」，没有任何错误提示或重试入口——这正是 `docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md:93`「**REST 失败：行内错误条 / toast**」明确要求而代码未实现的部分。
  - 变体 B（ticker 用兜底常量）：`App.tsx:14` 退回兜底 `100`（`shared/src/store-types.ts:80` 的默认值），而 `budget.data` 可能已是真实值 → `100 - 10000 = -9900` → 显示 `-9900 / 100`。
  - 变体 B′（原报告漏掉、我确认更隐蔽的镜像情形）：反过来 `GET /api/budget` 失败而 settings 成功时，`budget.data?.query ?? queryBudget` 让分子退化成 0 → ticker 显示 **`0 / 1000`**，看上去"今天一次都没查过"，而真实情况可能是预算已耗尽、轮询已被 `scheduler.ts:99-103` 推迟到明天。
  - 变体 C（校正）：保存时 `PUT` 成功但随后的 `settings.refetch()` 失败不会 reject（`useResource.ts:44-47` 只在内部 catch），`Settings.tsx:85` 仍执行 `setSaved(true)`——**但 PUT 确实已经落库，"已保存 ✓"这句话是真的**；真实缺陷是 `settings.data` 停在旧快照，于是 ticker/下次进入设置页仍显示旧上限，界面与实际持久化结果不一致。
- **后果**: 单次瞬时失败变成长期状态错乱：顶部进度用硬编码默认值与真实 remaining 混算（既可显示离谱负数，也可显示"看起来很正常"的 `0 / L`），设置页在会话内无法打开、用户既不被告知原因也没有重试入口。"只能刷新整页"是可行的恢复手段，所以用词应为"本次会话内长期"而非"永久"，但这意味着用户必须先猜到问题所在。
- **证据**:
  ```ts
  // packages/web/src/lib/useResource.ts:44-48
  } catch (e) {
    if (live()) setError(e instanceof Error ? e : new Error(String(e)));   // 不 rethrow、不重试
  } finally {
    if (live()) setLoading(false);
  }
  ```
  ```tsx
  // packages/web/src/pages/Settings.tsx:61-68 —— 只看 data，永远不看 error/loading
  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
      setEmail(settings.data.email ?? EMPTY_EMAIL);
    }
  }, [settings.data, form]);
  if (!form) return <div className="empty">{t('settings.loading')}</div>; // '加载设置中…'
  ```
- **验证备注**: 主体证据（错误被吞、无重试、无消费者）逐条成立，且与设计文档 §6 的显式要求冲突，维持 medium。被修正的是变体 C 的定性：不是"假成功"，而是"成功但显示不同步"。若不修掉这一处措辞，读者会以为 PUT 失败了。
- **建议**: `refetch` 失败时保留并可重试（`refetch` 已经暴露，只要渲染出来即可），设置页与 Shell 至少渲染 `settings.error` + 「重试」按钮；ticker 在 settings/budget 有 error 时显示占位符而不是默认预算；`Settings.tsx:85` 的「已保存」应以 PUT 成功为准，并把随后的 refetch 失败单独提示。

### [low] 设置表单只初始化一次（`!form` 守卫）+ PUT 全量覆盖 ⇒ 并发保存会静默回滚别人刚改的预算——**downgraded（medium → low）**

- **位置**: packages/web/src/pages/Settings.tsx:61-66（`!form` 守卫，保存后也永不与服务器重新同步）、83（`{...form}` 整对象提交）；packages/server/src/api/server.ts:129-146；packages/server/src/store/store.ts:172-176
- **触发路径（已确认，但前置条件比原报告暗示的更强）**: 标签页 A 停在设置页（`form.queryBudget = 1000`），标签页 B 把查询预算改成 10000 并保存；回到 A，只切一下 dry-run 开关再点保存 → 请求体里带着 A 的旧 `queryBudget: 1000`，`store.setSettings` 是浅合并、后写覆盖（`store.ts:173`），10000 被静默改回 1000。**复现要求"第二个客户端也停在设置页"**：同一标签页内不存在第二条 settings 写入路径（settings 资源只有挂载与 `Settings.tsx:84` 三处触发），所以单标签页流程不可达。
- **后果（校正后）**: 用户刚确认生效的预算被另一次无关保存悄悄回滚，无提示；由于 PUT 提交的就是整份表单，回滚后的界面与服务端其实是自洽的，只有重新挂载表单才会看到被改回的值。真正值得保留这条的理由是它同样能回滚 `dryRun`——`scheduler.ts:161` 在每次决定动作前实时读 `store.getSettings().dryRun`，一个陈旧的 `dryRun:false` 表单会把用户刚开启的演练模式关掉，使应用开始真实注册。但整体仍属"特定并发条件 + 可手动改回"的边界问题，降为 low。
- **证据**:
  ```tsx
  // packages/web/src/pages/Settings.tsx:62-66
  if (settings.data && !form) {
    // 只在第一次拿到 data 时写入，之后永不 resync
    setForm(settings.data);
    setEmail(settings.data.email ?? EMPTY_EMAIL);
  }
  ```
  ```ts
  // packages/server/src/api/server.ts:141 + store.ts:172-175
  const updated = deps.store.setSettings(parsed.data as Partial<Settings>);
  // store: this.data.settings = { ...this.data.settings, ...patch };  // 客户端整对象 = 全量覆盖
  ```
- **验证备注**: 机制与行号全部成立，但两点被夸大：① 原文"表单与服务端可以长期不一致"其实只由"email 被静默丢弃"（见最后一条）造成，正常字段在 PUT 成功后是一致的；② 整对象 PUT 是**有意设计**——`server.ts:132-135` 的注释明确说明"UI saves the whole settings object"，因此缺的是并发保护而不是"覆盖语义写错"。
- **建议**: 用 `PUT` 的返回值（或 `settings.data` 变化）重新同步表单，并在提交时只发送相对服务器快照真正变更过的字段（或带版本号/`updatedAt` 做乐观并发校验，冲突时提示）。

### [low] 数字输入用 `Number(e.target.value)`：清空/单字符输入产生 0 与 NaN，错误提示是原始 zod JSON；而注册预算的下界允许 0——**downgraded（medium → low）**

- **位置**: packages/web/src/pages/Settings.tsx:19-32（`NumField`）、28、88、100-103；packages/server/src/api/server.ts:58-68；packages/web/src/lib/api.ts:21-24；packages/server/src/scheduler/scheduler.ts:174-179
- **触发路径（已确认）**:
  - 清空「每日查询预算」输入框（受控 `value={value}` 会立刻把 `Number('') === 0` 回显成 `0`）后点保存 → 后端 `min(1)` 拒绝，`api.ts:23` 把整个 zod `flatten()` JSON 拼进 `Error.message`（形如 `PUT /api/settings failed: 400 — {"error":{"formErrors":[],"fieldErrors":{"queryBudget":[...]}}}`），`Settings.tsx:88` 原样显示在错误栏。
  - 输入框里只留一个 `-` → `Number('-') === NaN` → `JSON.stringify` 变成 `null` → 同样 400（React 还会对 `value={NaN}` 报警告）。
  - 清空「每日注册预算」后保存 → `min(0)` **接受 0**，`budget.canRegister()`（`budget.ts:12`：`registerCount < registerBudget`）当天恒为 false。
- **后果（校正后）**: 边界输入只能靠服务端 400 兜底且把原始 JSON 暴露给用户；`registerBudget = 0` 是"当天不再注册"的开关，且 ticker 会显示 `0 / 0`。但原文"无提示／静默功能全关"被夸大：输入框会立刻显示 `0`，ticker 显示 `0 / 0`，当真的出现空位时 `scheduler.ts:174-179` 还会打一条 `warn`（只是文案写成"Daily register budget reached"，其实是被配置成 0），所以用户并非完全无信号。schema 侧确实缺 `.int()/.max()`（`queryBudget: 1.5` 会被放行并等效于 2 次），但"天文数字一律放行"只是校验卫生问题（`queryBudget` 很大在语义上是允许的），且 `queryBudget` 有 `min(1)` 挡住了 0，与 `registerBudget` 的不对称更像是有意留的"今天不注册"开关。
- **证据**:
  ```tsx
  // packages/web/src/pages/Settings.tsx:25-28
  type="number"
  value={value}
  onChange={(e) => onChange(Number(e.target.value))}   // '' -> 0, '-' -> NaN
  ```
  ```ts
  // packages/server/src/api/server.ts:60-63
  pollIntervalMinutes: z.number().min(1),
  jitterMinutes: z.number().min(0),
  queryBudget: z.number().min(1),
  registerBudget: z.number().min(0),        // 0 = 当天永不注册，前端无任何说明
  ```
  ```ts
  // packages/server/src/scheduler/scheduler.ts:174-179 —— 只在"确有动作可做"的周期才会走到
  if (!budget.canRegister(now)) {
    this.noteSuccess(targetId);
    this.log('warn', 'Daily register budget reached — will retry next cycle', targetId);
    this.scheduleNext(target);
    return;
  }
  ```
- **验证备注**: 机制成立、行号成立，但严重度定级偏高：错误文案只是观感问题（服务端正确拒绝，状态不会被写坏），0 值虽有真实后果却要求用户主动清空字段并保存、且输入框/ticker/日志三处都有信号。降为 low。原文"每个周期只打一条 warn"也不准确——该分支只在 auto 模式且本轮真的出现可注册空位时才命中。
- **建议**: 前端在输入层做约束（`min`/`step`、拒绝空串与 NaN、提交前 clamp）并把 400 转成字段级提示；给 `registerBudget` 的 0 语义做显式说明或二次确认，补齐 `.int().max(...)`。

### [low] 保存查询/注册预算不会触发 `rescheduleWatching()`，提高预算后仍按旧预算拉伸出来的慢间隔等待——**confirmed（维持 low）**

- **位置**: packages/server/src/api/server.ts:136-144（只在 `pollIntervalMinutes`/`jitterMinutes` 变化时 reschedule）；packages/server/src/scheduler/scheduler.ts:258-283（`nextPollAt` 由 `budget.remaining()` 拉伸）、288-292
- **触发路径（已确认）**: 处于低预算状态（例如剩余 10 次、2 个目标 → `pollsPerTarget = 5`，距午夜 600 分钟 → `baseMin = max(30, 120) = 120` 分钟，`scheduler.ts:269-275`），此时把每日查询预算从 1000 改成 10000 并保存：`parsed.data` 里没有 cadence 字段变化 → `cadenceChanged = false`，已写入目标里的 `nextPollAt` 不变，最长要等约 2 小时（即上一次排出来的间隔）才按新预算重排。降低预算时同理：连查频率不会立刻变慢，但不会超支——`scheduler.ts:99-103` 的 `budget.canQuery(now)` 在每次轮询前实时判定，超额时会走 `scheduleAfterReset` 直接排到次日。
- **后果**: 用户改完预算后短时间内观察不到任何行为变化，容易误判「设置没生效」，与报障1 的显示错乱叠加削弱对设置页的信任。此外 ticker 展示的是配置间隔 `s?.pollIntervalMinutes`，而真正生效的是被预算拉伸后的间隔——这一点本 lane 未单列，属同源观感问题。
- **证据**:
  ```ts
  // packages/server/src/api/server.ts:137-144
  const cadenceChanged =
    (parsed.data.pollIntervalMinutes !== undefined &&
      parsed.data.pollIntervalMinutes !== before.pollIntervalMinutes) ||
    (parsed.data.jitterMinutes !== undefined && parsed.data.jitterMinutes !== before.jitterMinutes);
  const updated = deps.store.setSettings(parsed.data as Partial<Settings>);
  if (cadenceChanged) deps.scheduler.rescheduleWatching?.(); // 预算变化走不到这里
  ```
- **验证备注**: 逐行核对无误，`rescheduleWatching` 本身（`scheduler.ts:288-292`）实现正确、只是触发条件不含预算字段；`ApiScheduler.rescheduleWatching?` 是可选方法（`server.ts:29-31` 注释说明是给测试替身留的口子），不影响本判定。low 定级合适（延迟生效，无超支、无数据损坏）。
- **建议**: 把预算字段纳入 `cadenceChanged` 判定（或比较 before/after 的预算差异），预算变化后同样调用 `rescheduleWatching()`。

### [low] 邮件字段不完整时 PUT 静默省略 email，UI 报「已保存 ✓」但服务端保留旧 SMTP——**confirmed（维持 low）**

- **位置**: packages/web/src/pages/Settings.tsx:83（`email: ... ? email : undefined`）、85、87-90；packages/web/src/lib/api.ts:52-57（`JSON.stringify` 丢弃 `undefined`）；packages/server/src/api/server.ts:65、141
- **触发路径（已确认）**: 用户此前存过 SMTP 配置；现在把 host/user/pass/to 清空（`emailComplete = Boolean(...)` 为 false）且「邮件」通知未勾选（勾选时会被 `Settings.tsx:73-77` 提前拦住并提示 `settings.emailRequired`），点保存 → `JSON.stringify` 丢掉了值为 `undefined` 的 `email` 键，服务端 `store.setSettings` 浅合并保留旧 SMTP，而表单里显示为空、界面照旧显示「已保存 ✓」。客户端也确实没有任何"清空 email"的表达方式（`server.ts:65` 的 `emailSchema` 要求 host/port/user/pass/to 全部合法，`null` 会被 400），所以用户在 UI 上无法删除已存的旧凭据。
- **后果**: 旧 SMTP 凭据（含口令）长期留在 `data/store.json` 中且无法从界面清除；"表单值 = 服务端值"的前提被破坏，后续任何一次保存都会继续保留这份不可见的旧配置。实际风险有限：该场景下 `notify.email === false`，服务端不会真发信；而一旦勾选邮件通知，前端会先被 `emailRequired` 拦住，不会拿空配置去发信。
- **证据**:
  ```tsx
  // packages/web/src/pages/Settings.tsx:83-85
  await api.putSettings({ ...form, email: form.notify.email || emailComplete ? email : undefined });
  await settings.refetch();
  setSaved(true); // email 分支并未真正保存，提示照样显示
  ```
- **验证备注**: 行号有 1 行偏差（`setSaved(true)` 在 85，`catch` 在 86-89），语义完全正确；`Settings.tsx:80-82` 的注释表明"完整才持久化、避免用半截配置覆盖"是有意为之，缺的是"清空"这一显式语义，所以是 low 而非 medium。
- **附带核实（同源、同为 low，未达新增条目门槛）**: `saved` 徽标（`Settings.tsx:59/85/156`）在保存成功后不会因后续编辑而清除——用户改完预算点保存看到「Saved ✓」，随后又改了别的字段但没有再点保存时，徽标仍在，界面在断言一份并未持久化的状态；此时离开页面会在重新挂载时静默丢弃这次编辑。它与本条同属"界面声称已保存"的一类，修法相同（编辑时清 `saved`、用服务端返回值回填表单）。
- **建议**: 显式区分「不改动 email」与「清空 email」（例如发送 `email: null` 并放宽 schema，或单独的 `DELETE /api/settings/email`），保存后用服务端返回值回填表单，并在表单再次变化时清掉「已保存」徽标。
