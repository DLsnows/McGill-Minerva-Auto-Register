# P8 — Integration, dry-run rehearsal, docs Design

> 设计日期：2026-06-02 · 阶段：P8(收尾)· 依赖：P0–P7d(已合并)

## 1. 目标

收尾整个 AutoRegister:加入 **dry-run(干跑/演练)模式**让用户对着真实 Minerva 安全跑通完整
链路而不会真的注册;补齐**面向用户的文档**(README + TODO);完成端到端集成的确认。

## 2. Dry-run 干跑模式

**动机**:整条链路(登录→轮询→决策→注册/候补→通知→前端实时更新)各段已分别验证,但
"真的去注册"是不可逆的、且受学校操作次数限制。dry-run 让用户**安全演练完整链路**——照常
查询和决策,但在"即将提交注册"时只记录"本应执行什么",绝不真正提交。

**开关**:`Settings.dryRun: boolean`(默认 `false`),在 UI Settings 页用勾选框开/关,经
`PUT /api/settings` 持久化(与其它设置一致)。

**行为**(在 `Scheduler` 的执行路径中,即将调用 `actor.act` 之前判断 `store.getSettings().dryRun`):
- 开启时:记录一条 `action` 级事件 `DRY-RUN: would <REGISTER|WAITLIST> <CRN> — <reason>`,
  然后 `scheduleNext` 并返回 —— **不调用 `actor.act`、不消耗注册预算、目标状态保持 `watching`**。
- 查询照常发生(消耗查询预算),所以轮询节奏、决策、预算、通知都被真实演练到。
- **一键执行(forced run)同样受 dry-run 约束**:演练期间点 Dashboard 的"立即执行"也只记录
  "would ..." 而不真正注册(避免演练时意外提交)。
- dry-run 事件**照常流经通知管道**(桌面/声音/邮件按 Settings 的通知开关触发)——这样通知链路
  也一并被演练。

**注入点**:`Scheduler.runCycle` 中,notify-gate 之后、`budget.canRegister`/`actor.act` 之前
加一段 dry-run 短路。auto 与 forced 两条路径都经过此处,故两者都被覆盖。

## 3. API + 类型 + 前端

- `packages/shared/src/store-types.ts`:`Settings` 增 `dryRun: boolean`;`DEFAULT_SETTINGS.dryRun = false`。
- `packages/server/src/api/server.ts`:`settingsSchema` 增 `dryRun: z.boolean()`(仍在 `.partial()` 内)。
- `packages/web/src/pages/Settings.tsx`:在通知渠道一组旁/下加「Dry-run / 演练模式」勾选框,
  读写 `form.dryRun`;i18n 增 `settings.dryRun` + `settings.dryRunAria`(en/zh/fr)。

## 4. 文档

- **README.md**(重写为最终用户版,英文为主):
  - 是什么 + 负责任使用声明
  - 环境要求:Node 22+,`npm run -w @autoregister/server browser:install`(装 Playwright Chromium)
  - 安装:`npm install`
  - **使用流程**:`npm run serve` → 打开 `http://127.0.0.1:4575` → **Session** 页点登录(走学校 SSO,
    复用你已登录的浏览器,2FA 无需重输)→ **Courses** 加课(字段含 `?` 说明)→ **Settings** 配
    间隔/抖动/每日预算/通知渠道/邮箱(链 `EMAIL_SETUP.md`)/**dry-run** → **Dashboard** 点 Start 开始监控
  - 工作机制:间隔 + 抖动、每日查询/注册预算、单会话约束(别处登录会把自动化挤下线)
  - **dry-run 演练**:如何开、看控制台的 `DRY-RUN: would …`、确认无误后关掉再真跑
  - 语言切换(中/英/法)
  - 开发命令(lint/typecheck/test/build:web/serve)
  - 链接设计文档
- **TODO.md**:勾掉 P6、P7(并注明 P7a–d 拆分)、P8;反映最终状态。

## 5. 测试

- `scheduler`:dry-run 测试 —— auto 模式 + 有空位 + `dryRun=true` ⇒ `actor` 未被调用、
  记录了 `would` 事件、目标仍 `watching`、注册预算未变;另测 forced run 在 dry-run 下也不 act。
- `api` `server.test`:`PUT /api/settings` 接受 `dryRun: true` 并回读。
- `web` `Settings.test`:勾选 Dry-run 后保存,`putSettings` 收到 `dryRun: true`。
- 既有测试保持绿(新增 `dryRun` 字段不影响既有断言;`DEFAULT_SETTINGS` 多一字段)。

## 6. 集成确认

链路已在 P6 `createRuntime` 接好(API → scheduler → 真实 Minerva 适配器 → 通知 → WS → 前端),
P7a/P7c 也做过运行烟测。P8 不再加集成胶水;"集成"= 用 dry-run 对真实 Minerva 跑通端到端
(手动演练,文档给出步骤),并把流程写进 README。

## 7. 非目标

- 针对真实 Minerva 的自动化 e2e 测试(需真实登录会话,CI 无法运行 —— 由 dry-run 手动演练覆盖)。
- 打包为桌面应用 / 安装器(YAGNI)。
- 后端日志 / 通知 / 邮件文案的本地化(沿用既定:保持英文)。
- README 双语(界面已三语;README 以英文为主即可)。
