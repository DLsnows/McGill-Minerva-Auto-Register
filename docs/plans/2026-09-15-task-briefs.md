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
