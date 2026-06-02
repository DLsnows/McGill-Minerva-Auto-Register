# P7 Web 前端设计（Synapse UI）

> 设计日期：2026-06-02 · 阶段：P7（拆分为 P7a + P7b）· 上游设计：`2026-06-01-autoregister-design.md` §12

## 1. 目标

为 AutoRegister 提供 Synapse 暗黑玻璃风的本地 Web 控制台，接入 P6 的 REST + WebSocket API：
配置要监控的课程、查看实时轮询/决策/执行日志、一键执行、管理会话与设置（含 UI 内邮箱配置）。
单用户、本地运行（绑定 `127.0.0.1`），无需鉴权。

## 2. 技术栈

- **React + Vite + TypeScript**，挂在 `packages/web`（当前为占位空包）。
- **Tailwind CSS** + 一组 Synapse 设计令牌（颜色 / 字体 / 玻璃效果）。
- 字体：Instrument Serif（大标题）/ Inter（正文）/ JetBrains Mono（数据与日志）。
- 路由：`react-router`（顶部导航胶囊切换 Dashboard / Courses / Session / Settings）。
- 数据层：原生 `fetch` + 自定义 hook；实时日志走原生 `WebSocket`。**不引入 TanStack Query**
  （单用户本地工具，YAGNI）。
- 复用 `@autoregister/shared` 的类型（`WatchTarget` / `LogEvent` / `Settings` / `NotifyChannels` /
  `EmailConfig` / `DailyOps` / `SectionStats`），保证前后端零类型漂移。

## 3. 运行方式

- **开发**：`vite dev`（5173），Vite 代理把 `/api` 与 `/api/stream`（WS）转发到 Fastify（4575）。
- **使用**：`vite build` 产出 `dist`；Fastify 用 `@fastify/static` 托管 `dist`，未知路径 SPA fallback
  到 `index.html`。最终用户**一条命令（`npm run serve -w @autoregister/server`）+ 打开一个网址**即可。
- `@fastify/static` 仅在 `dist` 存在时注册；缺失时记录一条提示日志，API 仍照常工作（便于纯开发态）。

## 4. 文件结构（每单元单一职责）

```
packages/web/
  index.html
  vite.config.ts            # React 插件 + /api 与 /api/stream 代理
  tailwind.config.ts, postcss.config.js
  src/
    main.tsx                # 挂载 React + Router
    App.tsx                 # 应用壳：NavPills + Ticker + <Outlet/>
    theme/
      theme.css             # Tailwind 指令 + Synapse 令牌（CSS 变量）+ 字体
    lib/
      api.ts                # 所有 REST 调用，typed（复用 shared 类型）
      useEventStream.ts     # WebSocket hook → 实时 LogEvent 流 + 自动重连
      useResource.ts        # 通用 GET hook（初次加载 + 可选轮询 + refetch）
      format.ts             # 时间/倒计时/数字格式化等纯函数
    components/
      NavPills.tsx          # 顶部导航胶囊
      Ticker.tsx            # 数据跑马灯（监控数/间隔/今日操作/会话/下次轮询）
      CourseCard.tsx        # 单课卡片（六格 + 开关 + 徽章 + 一键执行）
      StatGrid.tsx          # cap/act/rem/wlcap/wlact/wlrem 六格
      StatusBadge.tsx       # 状态徽章（watching/waitlisted/registered/paused/...）
      ModeToggle.tsx        # auto ↔ notify 开关
      Console.tsx           # IDE 风实时控制台（分级着色日志）
    pages/
      Dashboard.tsx         # P7a：双栏 = 课程卡片列表 + 实时控制台
      Courses.tsx           # P7b：课程增删改表单
      Session.tsx           # P7b：会话状态 + 登录按钮
      Settings.tsx          # P7b：间隔/抖动/预算/通知渠道/邮箱配置
```

## 5. 数据流

- **初次加载**：REST 拉 `GET /api/targets`、`/api/budget`、`/api/session`、`/api/settings`、`/api/events`。
- **实时**：连接 `GET /api/stream`（WS）。服务端先推 `{type:'recent',events}`（快照），随后推
  `{type:'event',event}`（增量）。前端：
  - 控制台追加日志；
  - 收到事件后按需重拉 `targets`/`budget`（状态可能已变，如 paused / waitlisted）。
- **写操作 → REST**：
  - 加课 `POST /api/targets`、改 `PATCH /api/targets/:id`（含 mode 与 status）、删 `DELETE /api/targets/:id`；
  - auto↔notify：`PATCH` 该 target 的 `mode`；
  - **一键执行（立即执行一次）**：`POST /api/targets/:id/run` → 服务端对该课立即跑一轮
    「查询→决策→执行」。语义为**强制尝试**：忽略 auto/notify 的 gate（notify 课也会当场尝试注册/候补），
    但仍受**每日注册预算**约束（防止超过学校限制；预算耗尽时返回明确提示，不执行）。详见 §5.1。
  - 会话登录 `POST /api/session/login`；调度启停 `POST /api/scheduler/start|stop`；设置 `PUT /api/settings`。
  - 成功后乐观更新或重拉对应资源。

### 5.1 即时执行端点（P7a 内的小型 server 改动）

P6 的 API 仅有调度启停，没有「立即执行一次」。本期新增：

- **端点**：`POST /api/targets/:id/run`。校验 id 存在；触发即时执行；返回 `{ started: true }`
  （执行过程异步进行，结果通过既有的事件流 / WS 推送，与定时轮询一致）。
- **Scheduler**：`runOnce(id, opts?: { force?: boolean })`。`force: true` 时跳过 auto/notify 的
  mode gate（即 notify 课也会在有空位时执行），其余逻辑（会话检查、查询预算、查询、决策、注册预算、
  执行、状态更新、日志）与现有路径完全一致，复用同一套代码。
- **ApiScheduler 接口**：新增 `runTarget(id: string): void`（内部调用 `runOnce(id, { force: true })`）。
- **并发**：复用 Scheduler 现有的 ticking 守卫语义，避免与定时轮询的同一课并发执行。
- 该改动是对 P6 API 的**有针对性的最小扩展**，服务于「一键执行」核心需求，走正常 CI/AI review。

## 6. 错误处理 / 边界

- **WS 断线**：指数退避自动重连（上限 ~30s），Ticker 的会话点变灰显示 `reconnecting`。
- **REST 失败**：行内错误条 / toast，不使整页崩溃；按钮恢复可点击。
- **会话 `paused` / `logged-out`**：Dashboard 顶部醒目横幅 + 跳转 Session 页登录的引导。
- **邮箱配置**：前端做与后端一致的校验（host/port/user/pass/to 非空，port 为合法整数），保存前拦截；
  字段旁链接到 `docs/EMAIL_SETUP.md`（GitHub 上的 Gmail 应用专用密码指引）。
- **空态**：无课程时 Dashboard 显示引导“+ 添加课程”。

## 7. 测试（Vitest + React Testing Library + jsdom）

- `lib/api.ts`：mock `fetch`，断言 URL/method/body 与返回解析。
- `lib/useEventStream.ts`：mock `WebSocket`，验证快照→增量、重连退避。
- `lib/useResource.ts`：初次加载、refetch、错误态。
- `lib/format.ts`：纯函数全分支。
- 关键组件：`CourseCard`（开关与一键执行回调触发正确）、`Settings` 邮箱表单校验（空字段拦截）、
  `Console`（按 level 着色渲染）。
- 纯展示（`Ticker` / `StatusBadge` / `StatGrid`）：轻量渲染断言即可。
- Web 包接入根 `vitest`，纳入 `npm run test` 与 CI。

## 8. 阶段拆分（每阶段一个 PR → dev，过 CI/AI review + 人工确认后 merge）

- **P7a**：脚手架（Vite/TS/Tailwind 接入 monorepo + CI）+ Synapse 主题 + 数据层（`api`/`useResource`/
  `useEventStream`/`format`）+ App 壳（NavPills + Ticker + 路由）+ **Dashboard**（CourseCard / StatGrid /
  StatusBadge / ModeToggle / Console）+ Fastify 静态托管 `dist` + **即时执行端点 `POST /api/targets/:id/run`
  及 Scheduler `runOnce(force)` 支持**（§5.1）。
- **P7b**：**Courses** 配置表单（增删改）+ **Session** 页（状态 + 登录）+ **Settings** 页（间隔/抖动/
  查询预算/注册预算/通知渠道/邮箱配置 + 文档链接）。

## 9. 非目标（本阶段不做）

- 鉴权 / 多用户 / 远程访问（绑定 127.0.0.1，本地单用户）。
- 移动端适配（桌面为主；布局自适应但不专门做小屏）。
- Lighthouse / 部署（依赖 Vercel，暂缓，见上游设计）。
