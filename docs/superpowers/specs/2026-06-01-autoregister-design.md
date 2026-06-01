# AutoRegister — Design Spec

**Date:** 2026-06-01
**Status:** Approved (brainstorm complete)
**Repo:** DLsnows/McGill-Minerva-Auto-Register

McGill Minerva 课程席位自动监控与自动选课工具。本地 Web 应用，复用学生已登录的浏览器会话，按抖动间隔轮询指定课程，发现可执行的空位时按每课设定自动选课/加入候补，或提醒学生。

---

## 1. 目标与范围

### 1.1 目标
- 监控学生**明确指定**的若干门课（term + subject + faculty + course number + 目标 CRN）。
- 按用户设定的间隔（默认 30 分钟，带抖动）轮询每门课的席位状态。
- 依据席位/候补规则判定动作：**直接注册 / 加入候补 / 无操作**。
- 每门课可设为 **自动执行(auto)** 或 **仅提醒(notify)**；仅提醒模式额外提供"一键执行"。
- 处理候补的二次提交流程；捕获并报告所有错误。
- 通过桌面通知、声音、邮件、应用内实时控制台多渠道告警。
- 尊重学校每日操作上限：拟人化抖动 + 预算感知调度。

### 1.2 非目标（YAGNI）
- 不自动完成登录/二步验证（学生手动登录一次，复用会话）。
- 不做云端部署、多用户、账号体系。
- 不做 Lighthouse 性能审计（核心功能完成后再议）。
- MVP 不打包成 Electron 桌面应用（架构保持解耦，未来可加壳）。

### 1.3 成功标准
- 能稳定监控 ≥2 门课并正确判定动作。
- 自动模式能完成直接注册与候补加入（含二次提交）。
- 会话失效能检测并提示重新登录，不静默失败。
- 不因正常轮询触发学校限流（预算感知 + 抖动生效）。

---

## 2. 应用形态与技术栈

**形态：本地 Web 应用（方案 A）。** Node 后端跑自动化引擎 + Playwright，并提供 REST/WebSocket，同时托管 React 前端；用户打开 `localhost` 使用。

### Monorepo（npm workspaces）
```
packages/
  shared/   # TS 类型 + 纯决策引擎 + 表格解析器（无 IO，单测覆盖）
  server/   # Fastify + Playwright + sqlite + 调度/通知
  web/      # React + Vite + Tailwind（Synapse 主题）
```

### 依赖
- **server**：Node 22 + TypeScript、Fastify、ws、Playwright(chromium 持久化 context)、better-sqlite3、nodemailer、node-notifier、zod、pino
- **web**：React、Vite、TypeScript、TailwindCSS、zustand
- **测试/工具**：Vitest、ESLint、Prettier、tsc（对应 CI 的 `npm run lint / typecheck / test`）

---

## 3. 架构

```
web (React / Synapse)  ──REST + WebSocket──►  server
                                                ├─ api          Fastify REST + WS
                                                ├─ scheduler    预算感知编排：到点→查询→决策→执行/提醒
                                                ├─ budget       每日预算(查询/注册分开) + 抖动 + 拟人延迟
                                                ├─ minerva-client
                                                │    ├─ session   持久化 profile / 登录检测 / 健康检查
                                                │    ├─ query      高级搜索导航 → get sections → 解析表格
                                                │    └─ register   CRN 提交 → 候补二次提交 → 错误捕获
                                                ├─ decision-engine 纯函数(来自 shared)
                                                ├─ notifier      桌面 / 声音 / 邮件 / 控制台
                                                └─ store          sqlite：配置 / 日志 / 计数
```

**设计原则**：每个模块单一职责、接口清晰、可独立测试。
- `decision-engine` 为纯函数，所有判定逻辑脱离浏览器单测。
- `minerva-client` 把所有 DOM 操作隔离在一处。
- 单一浏览器 context 内**串行**轮询（拟人、避免并发猛刷）。

---

## 4. 数据模型（sqlite）

- **watch_target**：`id`、`term`、`subject`、`faculty`、`courseNumber`、`targetCrn`、`mode`(`auto`|`notify`)、`status`(`watching`|`registered`|`waitlisted`|`stopped`|`error`)、`lastStats`(json)、`lastPolledAt`、`nextPollAt`、`createdAt`
- **event_log**：`id`、`targetId?`、`level`(`info`|`action`|`warn`|`error`|`ok`)、`message`、`data`(json)、`ts`
- **daily_ops**：`date`、`queryCount`、`registerCount`（查询/注册分开计数）
- **settings**：`pollIntervalMinutes`(默认 30)、`jitterMinutes`(默认 ±3)、`queryBudget`(默认 100)、`registerBudget`(默认 20)、邮件配置、通知开关

---

## 5. 每课状态机

```
watching ──直接注册成功──► registered    [停止, 通知]
watching ──加入候补成功──► waitlisted    [停止, 通知]
watching ──(仅提醒)发现可执行空位──► action_available  (继续监控 + 卡片"一键执行"按钮)
                                       └─用户点击 → 执行 → registered / waitlisted  [停止]
watching ──操作失败(报错)──► 记录并报告 ──► watching  (继续轮询)
任意状态 ──会话失效──► paused (全局)  直到重新登录
用户手动 ──► stopped
```

**终态约定**：直接注册成功 = 任务完成；加入候补成功 = 任务完成（不再继续抢直接座位，通知学生后续自行处理）。

---

## 6. 决策规则（decision-engine）

输入：解析出的某 CRN 区段 `{ cap, act, rem, wlcap, wlact, wlrem }`。
输出：`{ action: 'REGISTER' | 'WAITLIST' | 'NOOP', reason }`。

- **有候补** ≡ `wlcap` 为 `> 0` 的整数。
- 无候补（或 `wlcap=0`）且 `rem > 0` → **REGISTER**
- 有候补且 `wlact = 0`（候补为空）且 `rem > 0` → **REGISTER**
- 有候补且 `wlact > 0` → 必须走候补；当 `wlrem > 0` → **WAITLIST**（即使 `rem > 0`）
- 有候补且 `wlrem = 0`，或 无候补且 `rem = 0` → **NOOP**（继续轮询）

该函数必须有覆盖全部分支的单元测试（含边界：`wlcap=0`、`wlact=0`、`rem=0` 等）。

---

## 7. 关键 Minerva 页面与流程

| 用途 | URL |
|---|---|
| 选择查询功能的 term | `https://horizon.mcgill.ca/pban1/bwskfcls.p_sel_crse_search` |
| 查询课程状态（含高级搜索） | `https://horizon.mcgill.ca/pban1/bwckgens.p_proc_term_date` |
| 注册（quick add/drop） | `https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin` |
| 选择 quick add/drop 的 term | `https://horizon.mcgill.ca/pban1/bwskflib.P_SelDefTerm` |

### 7.1 查询（query）
1. 选定查询 term。
2. 用**高级搜索**：选择 subject（如 `COMP - Computer Science (Sci)`）、faculty（如 Faculty of Science）、填入 course number（如 `551`）。
3. **Get Course Sections**，解析返回表格中每个区段的 `cap / act / rem / wlcap / wlact / wlrem`，按 **目标 CRN** 匹配（同一课程可能有多个四位数 CRN，以用户预设的 targetCrn 为准，避免选错）。

### 7.2 注册/候补（register/actor）
1. 进入 `P_AltPin` 前，用 `P_SelDefTerm` 确认/设置正确的 term（在 quick add/drop 右上角、当前日期上方校验当前 term）。
2. 在 CRNs 处填入目标 **CRN（四位数，非课号）** → **Submit Changes**。
3. 结果判定：
   - 成功 → `registered`。
   - 报错 **"Open-Space(s) Reserved for Waitlist"** → 在报错消息的 action 选项选 **Add to Waitlist** → 再次 **Submit Changes** → `waitlisted`。
   - **"Closed - class full" / "Waitlist full"** → 候补也满，记录并继续监控。
   - **其他未知报错** → 原文捕获 + 截图存档 + 记录日志 + 告警，继续监控。

---

## 8. 节流 / 防检测 / 每日预算

学校对每天操作次数有限制（查询与注册都计入，具体数字未知），需拟人化以免被限流/惹麻烦。

- **间隔与抖动**：轮询间隔有下限；默认 **30m ±3m** 随机抖动。每轮内动作（导航、输入、点击）加随机微延迟。
- **每日预算（分开计数，可在设置中调整）**：
  - **查询预算**：默认 **100/天**（低风险，主要作为程序失控护栏）。
  - **注册预算**：默认 **20/天**（高风险，含失败重试）。
- **预算感知调度**：调度器知道当前活跃课程数与剩余预算，会**自动拉长轮询间隔以匹配预算**，接近上限时在控制台与通知中**提前警告**，到上限则暂停至次日。
  - 提示：30m 间隔下一门课 ≈48 次查询/天，100 查询预算约够 2 门课跑满全天；更多课程需调高预算或拉长间隔。
- **串行**：单浏览器、顺序轮询，不并发。

---

## 9. 会话管理与健康

- **专用 Playwright 持久化 context**（独立 user-data-dir）。首次 **headful** 启动，学生手动完成 Duo/二步验证登录，cookie 持久化复用。
- **登录检测**：访问受保护页面，判断是否被重定向到登录页。
- **健康检查**：每轮轮询前/后校验会话有效；轮询活动本身有助于保活。
- **失效处理**：检测到登录跳转/超时 → **全局暂停 + 多渠道告警**；前端"会话"页显示状态与"打开浏览器重新登录"按钮。

---

## 10. 通知（notifier）

触发时机：发现空位、尝试执行、执行成功、执行失败、会话失效、预算接近上限。
渠道（均可在设置开关）：
- **应用内控制台**（始终开启，实时 WebSocket 推送，彩色分级日志）。
- **桌面通知**（node-notifier）。
- **声音**（提示音）。
- **邮件**（nodemailer，需用户配置 SMTP/邮箱授权码）。

---

## 11. 错误处理与报告

- 未知 Minerva 报错：**原文 + 页面截图**存档（`screenshots/`，gitignored），写日志并告警。
- 单门课出错不影响其他课程轮询（隔离）。
- 所有事件进 `event_log` 并实时推送到控制台。

---

## 12. 前端 UI（Synapse 设计系统）

暗黑玻璃风（Vantablack 底 + 紫/青光晕 + 玻璃拟态 + Instrument Serif 大标题 + Inter 正文 + 等宽数据）。已通过可视化预览确认方向。

- **主监控台 Dashboard**：双栏 = 左侧课程卡片列表（每课显示课程/CRN/subject、`cap/act/rem/wlcap/wlact/wlrem` 六格、自动/提醒开关、状态徽章、"一键执行"按钮）+ 右侧常驻 IDE 风格实时控制台。顶部导航胶囊 + 数据跑马灯（监控数/间隔/今日操作/会话状态/下次轮询）。
- **课程配置**：表单设置 term、subject、faculty、course number、目标 CRN、模式（auto/notify）、间隔。支持多课程管理（增删改）。
- **会话页**：登录状态 + 打开浏览器登录按钮。
- **设置页**：间隔/抖动、查询预算、注册预算、通知渠道、邮件配置。

---

## 13. 仓库 / 分支 / CI

- **分支**：`dev`（默认，工作分支）、`staging`、`prod`。PR 目标为 `dev`/`staging`。
- **移植自 Sonic_Bridge 的 CI**（适配 AutoRegister）：
  - `ci-lint-typecheck.yml` — ESLint + tsc，sticky comment。
  - `ci-unit-tests.yml` — Vitest，sticky comment。
  - `claude-code-review.yml` — Claude Code Action（经 DeepSeek），需 `DEEPSEEK_KEY` secret。
  - `pr-agent.yml` — PR Agent 自动 review/describe，需 `DEEPSEEK_KEY` secret。
- **跳过**：`vst3-validate.yml`（不适用）、`ci-lighthouse.yml`（依赖 Vercel 部署，暂缓）。
- **Secret**：`DEEPSEEK_KEY` 通过 `gh secret set` 加密存储，绝不明文进仓库。

---

## 14. 分阶段工程（每阶段一个 PR → dev，过 CI/AI review + 人工确认后 merge）

- **P0** 脚手架：monorepo + 工具链(ESLint/Prettier/tsc/Vitest) + 分支 + CI 移植 + `DEEPSEEK_KEY` secret + `TODO.md` + 本设计文档。
- **P1** `shared`：决策引擎（纯函数，全分支单测）+ 课程表格解析器（fixture 驱动单测）。
- **P2** `minerva-client/session`：持久化 profile + 登录检测 + 健康检查。
- **P3** `minerva-client/query`：高级搜索导航 + 实时解析，按 targetCrn 匹配。
- **P4** `minerva-client/register`：提交 + 候补二次提交 + term 校验 + 错误/截图捕获。
- **P5** `store` + `scheduler`(预算感知) + `budget/pacing` + `notifier`。
- **P6** `api`：REST + WebSocket。
- **P7** `web`：Synapse UI 接入 API（含一键执行）。
- **P8** 集成、干跑演练、文档、打磨。

---

## 15. TODO 清单机制

仓库根 `TODO.md` 维护阶段与勾选项，coding agent 每阶段更新进度。每阶段开工时用 superpowers `writing-plans` 生成该阶段详细任务清单，`executing-plans` 执行。

---

## 16. 法律 / 道德

- 仅自动化**学生本人**的选课操作，使用其本人已认证的会话。
- 拟人化与预算控制以尊重学校系统、避免限流。
- 学生需自行知悉并承担与学校使用条款相关的责任。
