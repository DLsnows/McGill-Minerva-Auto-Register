# 子任务施工手册

> 每个子任务一份。子智能体开工前**必须完整读完本文件对应章节 + 仓库根 `AGENTS.md`**。

---

## 通用规则（所有子任务适用）

### 你的工作目录
`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\<你的任务目录>`
这是一个 git worktree，分支已在任务书里指定。**不要 `cd` 到别的 worktree，不要动别人的分支。**

### 硬性纪律
1. **不碰别人的文件**：只改任务书列出的文件范围。超出范围先停下来在 PR 描述里说明。
2. **不碰 CI 之外的分支**：绝不 push 到 `dev` / `staging` / `prod` / `feat/ci-and-ux-overhaul`。
3. **不开 PR 到 `dev`**：你的 PR base 只能是 `feat/ci-and-ux-overhaul`。
4. **不自动合并自己的 PR**：开完 PR 停下来，把「本地门禁结果 + 需要人工判断的点」回报给调度者。
5. **i18n 三语同步**：`packages/web/src/i18n/index.ts` 的 zh/en/fr 三份字典都要改，缺一不可。只新增/修改你任务命名空间下的键。
6. **不留 TODO / 不写占位实现**。做不动的部分明确报告，不要假装完成。
7. **不修改 `package-lock.json`**，除非任务书明确授权。

### 环境
- npm 缓存已指向 `C:\Users\lenovo\deepseekHarness\Auto-Register\.npm-cache`（跑 npm 前设 `$env:npm_config_cache` 为该路径）。
- `node_modules` 已预装。若缺失：`npm ci --ignore-scripts`。
- 本项目在 Windows 上开发，CI 在 ubuntu 上跑。**脚本里的路径分隔符、换行符要跨平台**（用 `node:path`，不要硬编码 `\`）。

### 本地门禁（提交前必须全绿）
```powershell
$env:npm_config_cache = "C:\Users\lenovo\deepseekHarness\Auto-Register\.npm-cache"
npm run lint
npm run typecheck
npm test
npm run build:web
```
任何一项失败都必须修到通过。测试要**新增**覆盖你改动行为的用例，而不是只让老用例继续绿。

### PR 流程
```powershell
git add -A
git commit -m "<type>(<scope>): <summary>"
git push -u origin <你的分支>
gh pr create --base feat/ci-and-ux-overhaul --head <你的分支> `
  --title "<title>" --body-file <你写的 PR 描述文件>
```
PR 描述必须包含：**改了什么 / 为什么 / 本地门禁结果（贴输出摘要）/ 风险与回滚方式 / 需要 reviewer 重点看的点**。

### 评审意见处理（重要）
开完 PR 后 **Claude review bot 和 pr-agent 一定会跑**。你要：
1. 等它们在 PR 上留下评论（可用 `gh pr view <n> --comments`、`gh pr checks <n>` 查看；也可以用 `gh api repos/DLsnows/McGill-Minerva-Auto-Register/pulls/<n>/comments` 看行内评论）。
2. **逐条**判断：`已修` / `误报（说明为什么）` / `不改（说明理由）`。
3. 在每条评论下**回复**你的处置结论：
   ```powershell
   gh api repos/DLsnows/McGill-Minerva-Auto-Register/pulls/comments/<comment_id>/replies -f body="..."
   # 或对普通 issue 评论：
   gh pr comment <n> --body "..."
   ```
4. 修完再 push，重跑本地门禁。
5. 最后把「所有评论 + 你的处置」汇总回报给调度者。

---

## P1 — CI 与质量门禁

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\ci-quality-gates`
- **分支**：`feat/ci-quality-gates`
- **PR base**：`feat/ci-and-ux-overhaul`
- **这是关键路径任务**：其他 6 条子支线都要等你合入后才开工，请优先完成。

### 背景
本仓库当前 CI 只有两个 workflow（`ci-lint-typecheck.yml`、`ci-unit-tests.yml`），触发条件是 `branches: [dev, staging]`。默认分支是 `prod`，所以 **Dependabot 的 9 个 → prod 的 PR 完全没有 CI**。参考仓库 `DLsnows/Synchain` 的做法：只有 base 是长期分支（dev/stage/prod）的 PR 才跑全量 CI，子支线 PR 不跑、改由本地跑 gates。

### 必须交付

**1. `.github/workflows/ci.yml`（合并替代现有两个 ci-*.yml）**

- 触发：`pull_request` → `branches: [dev, staging, prod]`，`types: [opened, synchronize, reopened, ready_for_review]`。
- 三个 job：
  - `lint-and-typecheck`（`runs-on: ubuntu-slim`）：`npm ci` → `npx tsc --noEmit`（等价于 `npm run typecheck`）→ `npm run lint` → **prettier 只检查本 PR 改动的文件**（见下）。
  - `unit-tests`（`runs-on: ubuntu-latest`，`timeout-minutes: 20`）：`npm ci` → `npm test`。注意 `ubuntu-slim` 有 15 分钟硬上限，vitest 全套可能超时，所以这个 job 必须用 `ubuntu-latest`。
  - `web-build`（`runs-on: ubuntu-slim`）：`npm ci` → `npm run build:web`，确保前端能构建。
- 保留现有两个 workflow 的「sticky comment 汇总结果」能力（用 `marocchino/sticky-pull-request-comment@v2`，该 action 已在仓库允许列表里）。
- 保留 `concurrency` 取消进行中的旧运行。

**prettier 只检查改动文件**（重要）：仓库现状是 `npm run format:check` **本来是红的**（37 个文件不符合 prettier）。不要在本次 PR 里全量格式化（会污染 git blame），而是只对 PR 改动过的文件做检查：

```
git diff --name-only --diff-filter=ACMR origin/${{ github.base_ref }}...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.md' \
  | xargs -r npx prettier --check
```
- 本地对应命令请写成 `scripts/ci/format-check-changed.mjs`（跨平台，不依赖 bash/xargs），并加 npm script `format:check:changed`。
- 同时把 `npm run format:check`（全量）保留现状不变，只在文档里说明它是待清理的历史债。

**2. `.github/workflows/branch-gate.yml`**

照 Synchain 的做法，强制晋升链：
- `prod` ← 只接受 `stage` | `dev`
- `staging` ← 只接受 `dev`
- `dev` ← 只接受 `feat/*` | `feature/*`
- 拒绝来自 fork 的 PR（`github.event.pull_request.head.repo.full_name != github.repository`）。
- `runs-on: ubuntu-slim`，纯 shell。

**3. `.github/workflows/preview-e2e.yml`（前端「preview」验收）**

用户明确要「preview 后自己决定是否提 PR」。所以需要能在 CI 里对一个真实运行的前端做端到端验证：
- 触发：`pull_request` → `branches: [dev]`，`types: [opened]`（只在首次创建时跑一次，省成本）。
- 步骤：`ubuntu-slim` → `npm ci` → 装 Playwright chromium（`npx playwright install --with-deps chromium`，`playwright` 已是 server 的依赖）→ 构建 web → 启动一个**只依赖 API 契约、不连 Minerva** 的预览服务 → 用 Playwright 跑 `e2e/` 下的用例 → 上传截图与 trace 为 artifact → 用 sticky comment 贴结果。
- 关键：**不要连真实 Minerva**。请写一个 e2e 专用的假后端（`e2e/fake-server.mjs`，用仓库已有的 fastify 起一个内存版 API，实现 `GET/PUT /api/settings`、`GET /api/targets`、`POST /api/scheduler/start-all`、`GET /api/budget`、`GET /api/session`、`WS /api/stream`），让前端跑在它上面。
- e2e 至少覆盖：
  1. 打开首页 → 页面标题与 ticker 渲染出来（无控制台报错）。
  2. 课程页添加一门课 → 出现在列表。
  3. 设置页改「轮询间隔」并保存 → 提示已保存，重新加载后仍是新值。
  4. 语言切换 zh → en → fr 各渲染一次导航文案。
- 同时提供本地可跑的 npm script：`npm run e2e`（启动假后端 + 前端 preview + Playwright）。
- Windows 上有浏览器可用性问题时，允许用环境变量 `E2E_SKIP=1` 跳过（在脚本里做好判断），但 CI 上必须真跑。

**4. `.github/workflows/lighthouse.yml`**

- 触发：`pull_request` → `branches: [dev]`，`types: [opened]`（只跑一次，Lighthouse 贵）。
- **不要用 `treosh/lighthouse-ci-action`**：本仓库的 Actions 允许列表只放行了 `patrickedqvist/wait-for-vercel-preview`、`treosh/lighthouse-ci-action`、`marocchino/sticky-pull-request-comment`、`anthropics/claude-code-action`、`the-pr-agent/pr-agent`、`qodo-ai/pr-agent` 以及 GitHub 官方 + verified 的 action。为了不依赖管理员改设置，请**用 Node 脚本 + `npx lighthouse`** 实现：`runs-on: ubuntu-latest` → `npm ci` → 构建 web → 用 `vite preview`（或 fastify static）起本地服务 → 对 `/`、`/courses`、`/session`、`/settings` 各跑一次 `npx --yes lighthouse@12 <url> --only-categories=performance,accessibility,best-practices --chrome-flags="--headless=new --no-sandbox" --output=json --output-path=...` → 脚本解析 JSON 出表格 → sticky comment → 生成 artifact。
- 阈值策略：**不要一开始就 fail**（首次引入 Lighthouse，分数未知）。先把结果作为信息贴出来，并在脚本里保留一个可配置阈值（默认不阻塞，写清楚怎么打开）。
- 注意 SPA 路由：`vite preview` 需要 SPA fallback，确认 `/courses` 直接访问返回 index.html。

**5. `.github/dependabot.yml`**

- `package-ecosystem: npm`，`directory: /`，`schedule: weekly`。
- `target-branch: dev`（不要让依赖 PR 打到 prod）。
- **分组**：`dev-dependencies`（`dependency-type: development`）与 `production-dependencies`（`dependency-type: production`）两组，`update-types: [minor, patch]` 归组，**major 单独成 PR**。
- `open-pull-requests-limit: 3`，`commit-message.prefix: build(deps)`。
- `groups` 的 `applies-to: version-updates`。
- 加 `ignore` 规则避免噪音：对 `@types/*` 的 major 更新忽略。

**6. 本地门禁脚本 + 文档**

- `scripts/ci/local-gates.mjs`：一条命令串跑 lint → typecheck → changed-files prettier → test → build:web，任一失败即非零退出，输出清晰的分节摘要。加 npm script `gates`。
- `docs/CI.md`：说明触发矩阵（哪个 base 触发哪些 job）、为什么子支线 PR 不跑全量 CI、本地怎么跑 gates、Lighthouse/e2e 怎么手工重跑、成本考量（slim vs latest、为什么只 opened 触发）。

### 删除/保留
- **删除** `ci-lint-typecheck.yml` 与 `ci-unit-tests.yml`（被 `ci.yml` 取代）。
- **保留** `claude-code-review.yml` 与 `pr-agent.yml` **原样不动**（它们是评审基础设施，且当前 pr-agent 已 pin 到 commit SHA）。

### 不要做的事
- 不要改 `packages/**` 下的任何产品代码（除非是 e2e 需要的极小改动，且必须在 PR 里单独说明）。
- 不要把 Lighthouse 加到每条 PR 上。
- 不要引入新的第三方 GitHub Action。

### 完成标准
- 7 个文件/脚本全部落地：`ci.yml`、`branch-gate.yml`、`preview-e2e.yml`、`lighthouse.yml`、`dependabot.yml`、`scripts/ci/*`、`docs/CI.md`。
- 本地：`npm run gates` 全绿；`npm run e2e` 在本地能跑通（若 Windows 上确实跑不动，说明原因并确保 CI 路径正确）。
- YAML 语法自检：用 `npx --yes yaml-lint` 或 `node -e "require('yaml')..."` 之类方式确认四个 workflow 都能被解析（实在没有可用工具就人工逐行核对缩进并在 PR 里说明）。
- 开 PR 到 `feat/ci-and-ux-overhaul`，处理完所有 review 评论后回报。

### 回报格式
```
任务: P1
分支: feat/ci-quality-gates
PR: <url>
本地门禁: lint ✅ / typecheck ✅ / prettier-changed ✅ / test ✅(N 用例) / build:web ✅ / e2e ✅
评审评论处置: <逐条列出 comment → 处置>
需要人工判断: <列出>
```

---

## P2 — 预算进度显示一致性

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\budget-progress`
- **分支**：`feat/budget-progress`
- **PR base**：`feat/ci-and-ux-overhaul`

### 用户报障
> 「在初始上限比较低的时候（比如每天 1000 次查询），设置改到 10000 次之后，会莫名其妙显示类似 9000/1000 这样的进度。不过开始之后就正常了。」

### 已定位的根因（审计线 C 已核实，行号可直接引用）
- `packages/web/src/App.tsx:40`：`queryUsed={queryBudget - (budget.data?.query ?? queryBudget)}`——
  **`budget.data.query` 是「剩余量」，`queryBudget` 是「上限」，两者来自两次不同时刻的独立请求。**
- 保存设置时 `packages/web/src/pages/Settings.tsx:83-84` 只 `await settings.refetch()`，**没有 refetch budget**。
- 于是渲染出 `新上限 − 旧快照的剩余量`：上限 1000→10000、剩余快照 1000 → 显示 **9000/10000**（用户记忆中的 9000/1000）。
- 下调上限时还会出现负数：`100 − 995 = -895` → 渲染 `-895/100`。
- 「开始之后就正常了」的原因：轮询产生日志事件 → `Dashboard.tsx:38-43` 触发 budget refetch → 数值归位。
- 同类问题见 `packages/web/src/App.tsx:14-15` 的硬编码兜底（`?? 100` / `?? 20`）与 `:42`（注册预算同样算法）。

### 必须交付

1. **单一原子数据源**：让 `GET /api/budget` 在同一个 handler 内一次性读 settings 与 dailyOps，返回
   ```ts
   interface BudgetSnapshot {
     query:    { used: number; limit: number; remaining: number };
     register: { used: number; limit: number; remaining: number };
   }
   ```
   - 在 `packages/server/src/budget/budget.ts` 增加 `snapshot(now?)`，**一次** `getDailyOps()` + **一次** `getSettings()`，保证 `used/limit/remaining` 三者严格自洽（`used = min(count, limit)`、`remaining = max(0, limit - count)`）。
   - `packages/server/src/api/server.ts` 的 `GET /api/budget` 改返回 snapshot。
   - 保留 `remaining()`（scheduler 在用），或让 `snapshot()` 复用它内部逻辑，不要复制粘贴两套算术。
2. **前端只展示快照**：`packages/web/src/lib/api.ts` 的 `getBudget` 类型改成 `BudgetSnapshot`；`App.tsx` 删除 `queryBudget - ...` 的减法与硬编码兜底，ticker 直接读 `used` / `limit`。
   - `packages/web/src/components/Ticker.tsx` 的 props 改成接收 `query: {used, limit}` / `register: {used, limit}`（或等价的清晰形态）。**在 Ticker 内部对展示值做一次防御性 clamp**（`used` 至少 0 且不超过 `limit` 时按原样，越界时按 `limit` 显示），保证任何异常数据都不会渲染出 `9000/1000` 这种「分子大于分母」的形态。
   - 数据未就绪时显示占位（例如 `— / —` 或 loading 态），**不要**用 100/20 这种硬编码默认值冒充真实值。
3. **保存后同步刷新**：`Settings.tsx` 保存成功后同时刷新 settings 与 budget（并处理两者都失败时的错误提示——参照现有 `err` 状态，不要新增静默失败路径）。
4. **测试（必须有）**，至少覆盖：
   - server：`GET /api/budget` 在 settings 被 PUT 成新上限后的**同一个响应内** `used/limit/remaining` 自洽；`limit` 下调到低于已用次数时 `used === limit` 且 `remaining === 0`（不出现负数）。
   - budget 单元：`snapshot()` 的三种状态（当日零查询 / 部分使用 / 超额使用）。
   - web：`Ticker` 在 `used > limit` 的输入下不渲染出分子大于分母的文本。
   - web：Settings 保存后 ticker 显示的是**新上限与新 used**（可参照 `packages/web/src/pages/Settings.test.tsx` 与 `App`/`Dashboard` 现有测试的写法）。

### 约束
- 不改 scheduler 的预算消耗逻辑、不改 dailyOps 的翻转语义、不改每日预算守卫。
- 不要顺手改审计清单里其它条目。

---

## P3 — 首次「开始」立即轮询 + 主开关语义 + error 终态可恢复

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\start-polling`
- **分支**：`feat/start-polling`
- **PR base**：`feat/ci-and-ux-overhaul`

### 用户报障
> 「很多时候第一次设置出来的目标，点击开始后，并不会正常开始，而是必须要彻底关闭再重新点击全部开始之后，才会开始正常的轮询。」

### 已定位的根因（审计线 D 已核实）
**(a) 主开关的语义绑错了对象**：`packages/web/src/pages/Dashboard.tsx:103-126` 用「有没有课程处于 watching」决定按钮动作与标签（`anyWatching`），而不是引擎的真实 running 状态。新添加的课程默认 `status='watching'`（`store.ts:111`），而 `api/main.ts` **从不调用 `scheduler.start()`**（只有 `server.ts:189/201` 两个路由里调）。于是：
- 首次加课后按钮显示「监控 · 运行中 / ■ 全部停止」；
- 用户第一次点击走 `api.stopAll()` → 所有课程被改成 paused、引擎停止（**与期望完全相反**）；
- 用户要再点一次（此时标签才变成「全部启动」）或重启程序。

**(b) 新目标没有立即轮询**：`scheduler.start()` 只装 30s 的 `setInterval`（`scheduler.ts:309-318`），且新目标的 `nextPollAt` 是 `undefined`。恢复监控时（`start-all`）只把 status 改成 watching、**没有设置 `nextPollAt`**，所以第一次真正轮询要等下一次 tick 判定到期。用户点「开始」后 30 秒内看不到任何日志，会认为「没生效」。

**(c) error 是死状态**：`noteFailure` 连续 3 次失败后写 `status:'error'` 并停止轮询（`scheduler.ts:199-210`），而 UI 上 error 既不能 pause 也不能 resume 也不能「立即执行」（`CourseCard.tsx` 的 PAUSABLE/RESUMABLE 都不含 error），`start-all` 也只捞 paused（`server.ts:199`）。目标永久停摆，唯一出路是删掉重建。

### 必须交付

1. **引擎状态与课程状态解耦**（核心修复）：
   - `Dashboard.tsx` 的主开关必须以 `GET /api/scheduler` 的真实 `running` 为唯一依据决定「启动 / 停止」动作与标签（回到 p7b 原始设计意图）。
   - `SchedulerToggle` 的 `running` prop 传引擎真实状态；按钮 disabled 条件保持「未登录不能启动」。
   - 顶部 Ticker 的「监控中 N」保持不变（那是课程计数，语义不同），但要确保引擎停止时用户能看出「课程在列表里 ≠ 正在轮询」。
2. **点「开始」就立即轮询**：
   - 服务端在「目标进入 watching」的所有入口（`POST /api/targets`、`PATCH /api/targets/:id` 改成 watching、`POST /api/scheduler/start-all`）把该目标的 `nextPollAt` 设为「现在 + 一个小的随机抖动（建议 0–3 秒，避免多目标同时打服务器）」。
   - `scheduler.start()` 后立刻跑一次 `tick()`（不必等满 30s），或用等价的「启动即检查到期」实现。
   - `POST /api/scheduler/start-all` 的响应里带上 `resumed` 数量，前端据此给用户一条可见反馈（例如日志事件 + 按钮状态）。
3. **error 终态可恢复**：
   - 在目标进入 watching 时清除该目标的失败 streak。
   - 允许 `start-all`（或新增一个明确的「重新监控」动作）把 `error` 目标恢复为 watching；并在 `start-all` 响应里区分「恢复了 N 门 / 跳过了 M 门终态课程」。
   - `packages/web/src/components/CourseCard.tsx`：为 `error` 状态提供恢复入口（例如「重新监控」按钮），复用现有按钮样式与 i18n 命名空间。
4. **测试（必须有）**：
   - server：`PATCH /api/targets/:id` 把 paused → watching 后 `nextPollAt` 落在近未来（不是 `undefined`、不是 30 分钟后）。
   - server：`start-all` 后 `error` 目标可被恢复；`start-all` 的响应计数正确。
   - server：`scheduler.start()` 之后立即触发一次 tick（可用注入的 clock 断言）。
   - web：主开关在「有 watching 课程但引擎未启动」时显示的是**启动**语义，点击调用 `startAll` 而不是 `stopAll`（这是报障的直接回归测试，务必写）。
   - web：error 卡片渲染出恢复入口。

### 约束
- 不要改 `pauseAllWatching()` 的「启动时不自动恢复轮询」的既有设计意图（这是有意的安全保证）。
- 不要改 `FAILURE_LIMIT`（3 次）与失败连击的语义。
- 不要顺手改审计清单里其它条目（尤其不要动 P2 的 budget 相关文件）。

---

## P4 — 操作速度（操作间隔 + 抖动）设置

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\pacing-controls`
- **分支**：`feat/pacing-controls`
- **PR base**：`feat/ci-and-ux-overhaul`

### 需求
> 「希望设置中可以加上设置操作速度的选项，可以控制操作之间的空隙（现在是 5s 左右应该）和抖动范围。」

### 现状
- `packages/server/src/util/pacing.ts`：`humanPause(baseMs = 3000, jitterMs = 1000)`，下限 250ms。
- 全仓库 17 处调用（`minerva/query-client.ts` 9 处、`minerva/register-client.ts` 8 处）都是 `humanPause()` **无参调用**，所以实际是硬编码 3000±1000ms。
- 一个轮询周期要跑 9 次 humanPause，加上导航大约 30–60s，这是用户感觉「慢」的来源。

### 必须交付

1. **设置项**（`packages/shared/src/store-types.ts` 的 `Settings` + `DEFAULT_SETTINGS`）：
   - `opPauseMs: number`（默认 `3000`）——两次浏览器操作之间的基础间隔（毫秒）。
   - `opJitterMs: number`（默认 `1000`）——抖动范围（毫秒，`±opJitterMs`）。
   - 保留 `pollIntervalMinutes` / `jitterMinutes`（那是**轮询频率**，与**单周期内操作速度**是两件不同的事，UI 上要讲清楚区别）。
2. **pacing 改造**：`humanPause` 支持从运行时配置读取。推荐做法：
   - 在 `packages/server/src/util/pacing.ts` 增加 `configurePacing({baseMs, jitterMs})` + `getPacing()`，模块级状态；
   - 启动时（`scheduler/runtime.ts`）用 store 里的 settings 初始化；
   - `PUT /api/settings` 成功后重新应用（与现有 `rescheduleWatching` 的触发方式保持一致）。
   - 保留 `humanPause(baseMs, jitterMs)` 的显式传参能力（测试要用），无参调用时读运行时配置。
   - **下限必须保留 250ms**：用户把间隔设成 0 也不能把节奏打满（这是反检测设计要求）。
3. **设置 UI**（`packages/web/src/pages/Settings.tsx`）：
   - 两个数字输入（毫秒），带单位说明「毫秒」。
   - 用不同措辞与既有「轮询间隔 / 抖动」区分开：现有的是「多久查一次」，新的是「一次查询内部的每个点击之间等多久」。
   - 增加校验与提示：越界值（<250ms、>60000ms、负数、NaN）要么前端 clamp、要么给出明确的错误条，不能静默保存垃圾值。
   - **i18n 三语同步**：只新增 `settings.*` 命名空间下的 `opPause` / `opJitter` / `pacingSection` / `pacingHint` 等键（具体键名自定，但必须 zh/en/fr 齐全）。
4. **服务端校验**：`packages/server/src/api/server.ts` 的 settings zod schema 增加这两个字段的 `min/max` 约束（不要只靠前端）。
5. **测试（必须有）**：
   - `humanPause` 在配置 500/100 时落在 `[400, 600]` 区间（注入可预测的 `Math.random`）。
   - 下限：配置 `baseMs=0, jitterMs=0` 时仍 ≥250ms。
   - `PUT /api/settings` 写入后，新的 pacing 对后续 `humanPause` 生效。
   - web：设置页渲染出这两个输入并能保存（参照 `Settings.test.tsx` 的现有写法）。
6. **文档**：在 `README.zh.md` / `README.md`（至少中文版）的说明里补一句「操作速度」设置的作用与建议值，并强调不要设得过于激进。

### 约束
- 不要删掉 humanPause（反检测设计要求）。
- 不要改 `pollIntervalMinutes` / `jitterMinutes` 的语义。
- 不要动 `minerva/*-client.ts` 里 humanPause 的**调用位置**（只让它们读到新配置），避免与其它任务冲突。

---

## P5 — 邮件通知 UI 下架（后端保留、强制关闭）

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\email-sunset`
- **分支**：`feat/email-sunset`
- **PR base**：`feat/ci-and-ux-overhaul`

### 需求
> 「暂时下架邮件提示功能.」

已确认采用方案：**UI 隐藏 + 后端代码保留且强制关闭**（将来想恢复只需少量改动）。

### 现状
- UI：`packages/web/src/pages/Settings.tsx` 的「Email」勾选框（:117-119）、整节 SMTP 表单（:135-149）、`DOC_URL` 指向 `docs/EMAIL_SETUP.md`（:7-8）、email 完整性校验（:70-76）、保存时的 email 组装（:83）。
- 后端：`packages/server/src/notifier/email.ts`、`notifier.ts`（按 `settings.notify.email` 决定是否发信）、`api/server.ts` 的 settings schema 允许 `notify.email`。
- 类型：`packages/shared/src/store-types.ts` 的 `NotifyChannels.email` 与 `EmailConfig`。

### 必须交付

1. **前端彻底隐藏邮件相关 UI**：勾选框、SMTP 表单整节、设置指南链接、email 必填校验、保存时对 email 的组装。设置页不应再出现任何 email/SMTP 字样。
2. **保存时强制关闭**：`PUT /api/settings` 的 schema 处理后，服务端强制 `notify.email = false`（即使用户请求体里带 `true` 也被覆盖），确保**不可能**因残留数据而发信。同时启动时（`runtime.ts`）也把已持久化的 `notify.email` 归零并落盘，这样老用户的 `store.json` 里 `email: true` 也会被清掉。
3. **后端代码保留**：`notifier/email.ts`、`EmailConfig` 类型、`email` 配置字段**都不要删**（将来恢复用）。`Notifier` 里对 email 的分支保留，但因为 `notify.email` 永远为 false，实际不会发信。
4. **文档**：`docs/EMAIL_SETUP.md` 顶部加一个明显的「该功能已暂时下架」提示块（说明 UI 已隐藏、后端已强制关闭、如何恢复），**不要删除该文档**。README 三语里若提到邮件通知，补一句「暂时下架」。
5. **i18n**：移除或保留 `settings.email*` 键由你决定，但**保证 zh/en/fr 三份字典结构仍然一致**（类型是 `typeof en`，少一个键会编译失败）。推荐保留键不删（免得将来还要补回来），只是不再渲染。
6. **测试（必须有）**：
   - server：`PUT /api/settings` 带 `notify.email: true` 时，读回的 settings 里 `notify.email === false`。
   - server：启动时把持久化的 `notify.email: true` 归一化为 false。
   - server：`Notifier` 在 `notify.email === false` 时不调用 email 发送（若已有类似用例则补强）。
   - web：设置页不再渲染任何 email / SMTP 相关字段（`Settings.test.tsx` 里现有的 email 相关用例要相应调整，并新增「不出现 SMTP 输入」的断言）。

### 约束
- 不要删 `nodemailer` 依赖、不要删 `notifier/email.ts`、不要删 `EmailConfig` 类型、不要删 `docs/EMAIL_SETUP.md`。
- 不要动 `notify.desktop` / `notify.sound`。

---

## P6 — Windows 一键不休眠开关

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\keep-awake`
- **分支**：`feat/keep-awake`
- **PR base**：`feat/ci-and-ux-overhaul`

### 需求（原文）
> 「给 windows 用户一个一键不休眠开关，打开之后电脑不会进入休眠（但是显示器自然关闭）。如果是笔记本，则是连接电源的话电脑不会休眠。但是用电池的话还是休眠。也放在设置里，然后这里给用户要讲清楚。」

已确认：**仅 Windows 显示该开关，其他平台隐藏**。

### 技术方案（已验证可行）
用 PowerShell 调 Win32 `SetThreadExecutionState`，由一个长期存活的子进程持有执行状态；子进程退出时状态自动失效（**不修改用户的电源计划**，这是与 `powercfg /change` 的关键区别）。

**已在本机实测通过的脚本骨架**（注意 `[uint32]` 转换必须避免 PowerShell 把 `0x80000000` 当成负数，实测要用十进制字面量或 `[uint32]` 变量拼接）：

```powershell
$sig = @"
using System;
using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
Add-Type -TypeDefinition $sig -ErrorAction Stop
[uint32]$ES_CONTINUOUS      = 2147483648   # 0x80000000
[uint32]$ES_SYSTEM_REQUIRED = 1            # 0x00000001
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED   # 不加 ES_DISPLAY_REQUIRED → 显示器照常关闭
# 每 30 秒刷新一次；stdin 收到 "stop" 或管道关闭时用 $ES_CONTINUOUS 复位
```

**笔记本电源判断**：`Get-CimInstance -ClassName Win32_Battery` 有返回 = 笔记本；无返回 = 台式机（本机实测台式机返回空，符合预期）。电池状态用返回对象的 `BatteryStatus` 字段（2 = 接电源，1 = 用电池）。
> 注意：`powercfg /requests` 需要管理员权限（本机实测报错），**不要用它**。

### 必须交付

1. **服务端模块** `packages/server/src/system/keep-awake.ts`：
   - `isSupported()`：仅 `process.platform === 'win32'` 为真。
   - `getPowerSource()`：通过 PowerShell 查 `Win32_Battery` → `'ac' | 'battery' | 'desktop' | 'unknown'`。
   - `start()` / `stop()` / `status()`：管理 keeper 子进程；`status()` 返回 `{supported, settingEnabled, active, powerSource, reason}`。
   - **接电源才生效**：用电池（`powerSource === 'battery'`）时**停止休眠保持**；插上电源后自动恢复。实现方式建议由服务端**周期性轻量轮询电池状态**（例如每 60 秒一次 PowerShell 调用，成本很低）并在状态变化时切换 keeper。
   - **进程清理**：`process.on('exit'/'SIGINT'/'SIGTERM')` 与 `app.close()` 时确保 keeper 子进程被杀掉，绝不能留下孤儿进程。
   - PowerShell 不可用 / 调用失败时：不要抛异常打崩服务，降级为 `{active:false, reason:'unavailable'}` 并记录。
2. **设置项**：`Settings.keepAwake: boolean`（默认 `false`，因为这是改变机器行为的开关，默认不开启更安全）+ 更新 `DEFAULT_SETTINGS`。
3. **API**：
   - `GET /api/power`（或在 `/api/settings` 里附带）返回 `{supported, enabled, active, powerSource, reason}`。
   - 设置保存后立即应用/撤销。
   - 非 Windows 平台上接口返回 `supported:false`，且不启动任何子进程。
4. **设置 UI**（`packages/web/src/pages/Settings.tsx`）：
   - **仅当 `supported === true` 时渲染**该开关（其他平台整块不出现，也不留空位）。
   - 开关下方必须把用户要求讲清楚（三语文案，`settings.*` 命名空间）：
     - 打开后电脑不会自动进入休眠；
     - **显示器仍会正常关闭**（不休眠 ≠ 不关屏）；
     - 笔记本**只有接着电源时**才保持不休眠，**用电池时仍然会休眠**（省电保护）；
     - 台式机插着电即全程生效；
     - 关掉开关或退出本程序后立即恢复正常电源行为。
   - 显示当前实际状态（生效中 / 等待接入电源 / 已关闭 / 不支持），状态来源是 `GET /api/power`。
5. **测试（必须有）**：
   - `isSupported()` 在 `platform='win32'` 时为 true、其它为 false（可注入 platform 或用环境变量覆盖，不要在测试里真的改 `process.platform`）。
   - 电池状态为 `battery` 时 `start()` 不启动 keeper；切到 `ac` 后启动（用可注入的 power-source provider 假实现）。
   - `stop()` 会终止子进程（用假的 spawn 实现断言调用参数，**不要真的 spawn powershell**）。
   - 非 Windows 上 `start()` 是空操作。
   - web：`supported:false` 时设置页不渲染该开关；`supported:true` 时渲染且文案齐全。
6. **文档**：README（中文至少）补一节说明这个开关与它的边界（只防休眠、不防关屏、电池下不生效）。

### 约束
- **不要修改用户的电源计划**（禁止 `powercfg /change`）。用 `SetThreadExecutionState`。
- 不要用 `powercfg /requests`（需要管理员）。
- 不要让 PowerShell 调用阻塞请求线程（异步 spawn，设置超时）。
- 不要为了这个功能新增 npm 依赖。

---

## P7 — 添加课程表单：标注必填 / 选填

- **工作目录**：`C:\Users\lenovo\deepseekHarness\Auto-Register\wt\course-form-labels`
- **分支**：`feat/course-form-labels`
- **PR base**：`feat/ci-and-ux-overhaul`

### 需求
> 「添加目标课程那边，可以写一下哪些空是必填，哪些空是选填（如果有的话）。」

### 现状
- `packages/web/src/components/CourseForm.tsx:26-33` 已有一份 `FIELDS` 定义，其中 `required` 字段**已经存在但完全没被用来渲染任何标记**——只参与了 submit 时的校验（:73-76）。
- 必填：`term` / `subject` / `faculty` / `courseNumber` / `targetCrn`；选填：`label`；`mode` 有默认值（auto），语义上是选填。
- i18n `form.*` 命名空间在 `packages/web/src/i18n/index.ts`（zh/en/fr 三份）。

### 必须交付

1. **视觉标注**：每个字段标签后有明确标记——必填加 `*`（并用 `aria-required`/`required` 等无障碍属性表达），选填显示「（选填）」/「(optional)」/「(facultatif)」字样。用现有 CSS 变量做样式，不要引入新的 UI 库。
2. **表单顶部一句话说明**：例如「带 * 的为必填项」，让用户一眼看到图例。
3. **校验提示更精确**：现有 `form.required` 是笼统的「Term, Subject, Faculty, Course # 和 Target CRN 是必填的」。改成**高亮缺失的字段**（例如把缺失字段的输入框边框标红 + 在字段下方给出提示），保留原有的错误条作为兜底。
4. **`mode` 字段**：说明它有默认值（不选就是 auto），措辞上不要造成「必须选」的误解。
5. **i18n 三语同步**：在 `form.*` 命名空间新增所需键（如 `requiredMark`、`optionalMark`、`requiredLegend`、`fieldRequired` 等，键名自定），zh/en/fr 必须齐全。
6. **测试（必须有）**：新增/调整 `packages/web/src/components/CourseForm.test.tsx`：
   - 必填字段带必填标记（按 `aria-required` 或可访问名断言，不要只断言 `*` 字符）。
   - 选填字段带「选填」标记、且不带必填标记。
   - 只填部分必填项提交时：不调用 `onSubmit`，且缺失字段被标出（断言具体是哪些字段被标记）。
   - 全部填好后提交：`onSubmit` 收到 trim 后的值（这条若已有则保留）。
   - 图例文案存在。
7. **`Courses.tsx` 的编辑表单复用同一个 `CourseForm`**，所以改动自动生效；确认编辑态下标记也正确渲染，并补一条断言。

### 约束
- 只动 `CourseForm.tsx`、`Courses.tsx`（如确有必要）、`i18n/index.ts` 的 `form.*`、以及对应测试。
- 不要改提交逻辑的字段裁剪行为，不要新增/删除表单字段。
- 不要动 `settings.*` 命名空间。
