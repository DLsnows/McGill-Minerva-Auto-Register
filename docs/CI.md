# CI 与质量门禁

本仓库的 CI 由 6 个 workflow 组成（`.github/workflows/`）：

| Workflow                 | 触发                                                                                  | 作用                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ci.yml`                 | PR → `dev` / `staging` / `prod`（opened / synchronize / reopened / ready_for_review） | 全量门禁：lint+typecheck+prettier(changed) / unit-tests / web-build，聚合成一条 sticky 评论 |
| `branch-gate.yml`        | PR → `dev` / `staging` / `prod`（同上）                                               | 强制晋升链 + 拒绝 fork                                                                      |
| `preview-e2e.yml`        | PR → `dev`，**仅 `opened`**                                                           | Playwright 对真实前端产物跑端到端验收（假后端，不连 Minerva）                               |
| `lighthouse.yml`         | PR → `dev`，**仅 `opened`**                                                           | 对本地托管的构建产物跑 Lighthouse（默认不阻塞）                                             |
| `claude-code-review.yml` | 所有 PR                                                                               | Claude 评审（评审基础设施，勿改）                                                           |
| `pr-agent.yml`           | 所有 PR                                                                               | pr-agent 评审（评审基础设施，勿改）                                                         |

---

## 触发矩阵

| PR base                                     | full CI (`ci.yml`) | branch gate                               | preview e2e  | Lighthouse   | 评审 bot |
| ------------------------------------------- | ------------------ | ----------------------------------------- | ------------ | ------------ | -------- |
| `dev`                                       | ✅                 | ✅（head 必须是 `feat/*` 或 `feature/*`） | ✅ 仅 opened | ✅ 仅 opened | ✅       |
| `staging`                                   | ✅                 | ✅（head 必须是 `dev`）                   | ❌           | ❌           | ✅       |
| `prod`（默认分支）                          | ✅                 | ✅（head 必须是 `dev` 或 `staging`）      | ❌           | ❌           | ✅       |
| `feat/**`、`feature/**`（子支线 / 集成 PR） | ❌ **不跑**        | ❌                                        | ❌           | ❌           | ✅       |

**为什么子支线 PR 不跑全量 CI**：子任务分支的 PR base 是集成分支（例如 `feat/ci-and-ux-overhaul`），
按设计它们只是"可以合的中间态"，真正的把关点是集成 PR → `dev`。如果每条子支线 PR 都跑一遍
全量矩阵 + Playwright + Lighthouse，成本会随支线数量线性增长，而收益几乎为零——过几分钟集成分支
变了，子支线还得重跑。因此：

- **子支线本地跑 `npm run gates`**（等价于 `ci.yml` 的前 5 项检查，跑在工作区而不是推送的 commit 上）。
- 集成 PR（`feat/<integration>` → `dev`）会拿到完整的 CI + branch gate + preview e2e + Lighthouse。

## 本地怎么跑

```powershell
$env:npm_config_cache = "C:\Users\lenovo\deepseekHarness\Auto-Register\.npm-cache"   # 或你本机的 npm 缓存

npm run gates                 # lint → typecheck → prettier(changed) → test → build:web
npm run gates -- --e2e        # 再加上 e2e（需要先 npm run e2e:install）
npm run gates -- --base origin/dev --only lint,test
```

- `gates` 里任何一项失败都会继续跑完其余项，最后打印汇总表并以非零码退出（CI 里失败即失败）。
- prettier 那一步只检查**相对 base 改动过的文件**，base 解析顺序：
  `--base` / `BASE_REF` → `origin/HEAD` → `origin/dev` → `origin/staging` → `origin/prod` → `origin/main` → `origin/master` → `HEAD~1`。
- 只跑单项就用原来的脚本：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build:web`、
  `npm run format:check:changed`。

## `ci.yml` 的三个 job

| Job                  | Runner          | 内容                                                                             | 为什么这个 runner                                                                                                                                          |
| -------------------- | --------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint-and-typecheck` | `ubuntu-slim`   | `npm ci` → `npm run lint` → `npm run typecheck` → `npm run format:check:changed` | 便宜（1 vCPU），几分钟内跑得完                                                                                                                             |
| `unit-tests`         | `ubuntu-latest` | `npm ci` → `npm test`                                                            | **必须用 latest**：`ubuntu-slim` 有硬性 15 分钟上限且不可调；vitest 全套（shared + server + web/jsdom）可能被拦腰取消。显式 `timeout-minutes: 20` 说明意图 |
| `web-build`          | `ubuntu-slim`   | `npm ci` → `npm run build:web`                                                   | 和 lint 同量级，deps 有 npm 缓存                                                                                                                           |
| `report`             | `ubuntu-slim`   | 汇总三个 job 的 Markdown 片段，发一条 sticky 评论                                | 每个 job 先把小结写成 artifact，`report` 按固定顺序拼接，所以评论形状永远一致                                                                              |

### prettier 为什么只查改动文件

`npm run format:check`（全量）**当前是红的**：本仓库有约 37 个文件早于现行 Prettier 配置。
在一次 CI 改造 PR 里顺手全量格式化会淹没 diff，并且毁掉这些文件的 `git blame`。

因此在还清这笔历史债之前：

- `ci.yml` 只对**本 PR 改动过的** `.ts/.tsx/.js/.mjs/.json/.md/.yml/.css` 跑 prettier
  （`git diff --name-only --diff-filter=ACMR origin/<base>...HEAD`，再用 `git check-ignore` 过滤 `.prettierignore`）。
  实现在 `scripts/ci/format-check-changed.mjs`（跨平台，不依赖 bash/xargs）。
- 全量 `format:check` 保持原样，作为**待清理的历史债**记录在这里，不在 CI 里跑。

想还这笔债：单独开一个 `chore/format-repo` PR 跑 `npm run format`，在 `.git-blame-ignore-revs` 里
登记该 commit，然后把 `ci.yml` 的 prettier 步骤换成全量 `npm run format:check`。

## preview e2e（`preview-e2e.yml`）

- **只在 PR → `dev` 且 `opened` 时跑一次**。整套（Chromium 下载 + 构建 + 用例）是本仓库最贵的 job，
  每个 PR 一次权威结果足够；push 之后不再重跑。
- **不连真实 Minerva**：`e2e/fake-server.mjs` 用 fastify 起一个内存版 API
  （`GET/PUT /api/settings`、`GET/POST/PATCH/DELETE /api/targets`、`POST /api/scheduler/start-all`、
  `GET /api/budget`、`GET /api/session`、`WS /api/stream`），同时用 `@fastify/static` 托管
  `packages/web/dist` 并做 SPA fallback —— 和 `packages/server/src/api/server.ts` 的生产形态一致。
  这样一条链路同时提供前端与 API，比 `vite preview` + 代理更接近生产（`vite.config.ts` 的
  `preview` 段没有 `/api` 代理）。
- **覆盖的用例**（`e2e/run.mjs`）：首页标题/ticker/控制台无报错、课程页添加课程后出现在列表、
  设置页改轮询间隔并保存后重新加载仍是新值、语言切换 zh → en → fr 各自渲染导航文案。
- 产物：`e2e/artifacts/`（每个用例的截图、trace zip、`summary.md`/`summary.json`），
  上传为 `preview-e2e-artifacts` artifact（保留 7 天），并把 `summary.md` 作为 sticky 评论贴出来。
- 本地：`npm run e2e:install`（把版本匹配的 Chromium 装到 `<repo>/.pw-browsers`，避免用机器级
  缓存里版本不符的构建）→ `npm run e2e`。脚本会自动探测 `.pw-browsers` / `.ms-playwright` /
  Playwright 默认缓存。
- 逃生阀：`E2E_SKIP=1 npm run e2e` 直接跳过（退出码 0）；`E2E_ALLOW_SKIP=1` 在缺浏览器时降级为
  "跳过并记一笔"。**CI 上不使用这两个变量**——CI 必须真跑。

## Lighthouse（`lighthouse.yml`）

- **只用 `npx lighthouse`**，不用 `treosh/lighthouse-ci-action`：不依赖仓库管理员维护 Actions
  允许列表，阈值与 SPA 路由契约都写在仓库里，可 review。
- **只在 PR → `dev` 且 `opened` 时跑一次**（Lighthouse 要 `ubuntu-latest`，分钟级耗时）。
  要重跑：推一个新 commit（不会触发）→ 实际做法是**重开一个新 PR**，或本地 `npm run lighthouse`。
  这里和 `preview-e2e.yml` 保持同一套成本策略。
- 流程：`npm ci` → `npm run build:web` → `scripts/ci/lighthouse.mjs` 用 fastify 托管 `dist`
  （先断言 `/courses` 深链接返回 SPA shell，确认 fallback 生效）→ 对 `/`、`/courses`、`/session`、
  `/settings` 各跑一次 `npx --yes lighthouse@12 <url> --only-categories=performance,accessibility,best-practices
--chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json` → 解析 JSON 出表格 →
  sticky 评论 + `lighthouse-reports` artifact（保留 14 天）。
- **默认不阻塞**：首次引入 Lighthouse，分数基线未知，先把结果作为信息贴出来。打开阻塞：

  ```yaml
  env:
    LH_ENFORCE: ${{ vars.LIGHTHOUSE_ENFORCE || '0' }} # 仓库变量设为 1 即开关
    LH_MIN_PERFORMANCE: '70' # 仅对 `/` 生效（SPA 客户端路由页的 perf 分数没有意义）
    LH_MIN_ACCESSIBILITY: '90'
    LH_MIN_BEST_PRACTICES: '90'
  ```

  或给步骤加 `--enforce` / `--min-performance <n>` 等参数。本地：
  `npm run lighthouse -- --enforce --min-accessibility 95`。

- 注意：`index.html` 从 Google Fonts 加载字体，CI 里字体请求失败会影响 lab 分数——这是环境效应，
  不是页面回归，读分数时把这一点算进去。

## 分支模型与 branch gate

```
prod    ← staging | dev
staging ← dev
dev     ← feat/* | feature/*
```

`branch-gate.yml` 用纯 shell 检查 `github.base_ref` / `github.head_ref`（`runs-on: ubuntu-slim`，
不需要 checkout）。它**先拒绝 fork**：`github.head_ref` 只是分支名（不带 fork 前缀），
否则 fork 里同名的 `dev` 分支就能混过晋升链。

## 成本考量一览

| 决策                                            | 原因                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| lint / web-build / branch-gate 用 `ubuntu-slim` | 1 vCPU 足够，分钟计费更低；这些任务远低于 slim 的 15 分钟硬上限        |
| unit-tests 用 `ubuntu-latest`                   | slim 的 15 分钟硬上限不可调，vitest 全套可能被取消                     |
| preview e2e / Lighthouse 只在 `opened`          | 最贵的两个 job；每个 PR 一次权威运行够用，不随每次 push 重跑           |
| e2e / Lighthouse 只对 base=`dev`                | `dev` 是新代码入口；`staging`/`prod` 是晋升 PR，内容已经在 `dev` 验过  |
| 子支线 PR 不跑全量 CI                           | 见上文"触发矩阵"；子支线用本地 `npm run gates`                         |
| Lighthouse 默认不阻塞                           | 首次引入，先建立基线再收紧                                             |
| `dependabot.yml` `target-branch: dev`           | 默认分支是 `prod`，依赖 PR 打到 `prod` 既违反晋升链、以前又完全没有 CI |

## Dependabot

`.github/dependabot.yml`：npm、weekly、`target-branch: dev`、`open-pull-requests-limit: 3`、
commit 前缀 `build(deps)`。

- `development-dependencies`：dev 依赖的 minor/patch 合成一个 PR。
- `production-dependencies`：prod 依赖的 minor/patch 合成一个 PR。
- **major 一律单独成 PR**（groups 只收 `update-types: [minor, patch]`）。
- `@types/*` 的 major 更新被 ignore（DefinitelyTyped 的 major 跟随上游库发布，噪音大于价值）。

因为目标是 `dev`，这些 PR 会走 `ci.yml` + branch gate。注意 branch gate 要求 head 是
`feat/*` / `feature/*`，而 Dependabot 的分支名是 `dependabot/npm_and_yarn/...`，**因此依赖 PR 会被
branch gate 拦下**。这是有意的：依赖升级应当由维护者审阅后自行开 `feat/` 分支（或临时放行）合入，
而不是自动流进 `dev`。若希望放行，在 `branch-gate.yml` 的 `dev` case 里加上 `dependabot/*`。

## 故障排查

| 现象                                                          | 原因 / 处理                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 子支线 PR 上没有任何 CI                                       | 按设计如此（base 不是长期分支）。跑 `npm run gates`                                           |
| `format:check:changed` 报 `could not resolve a base revision` | 浅克隆或缺 `origin/*`。`fetch-depth: 0` 已配好；本地执行 `git fetch origin` 或 `--base <ref>` |
| preview e2e 报 `Executable doesn't exist`                     | 本地缺版本匹配的 Chromium：`npm run e2e:install`                                              |
| preview e2e 报 `web build not found`                          | 先 `npm run build:web`（`npm run e2e` 已经串了这一步）                                        |
| Lighthouse 报 `Chrome` 找不到                                 | CI 用 `ubuntu-latest`（自带 Chrome）；本地用 `LH_CHROME_PATH` / `CHROME_PATH` 指定            |
| 想重跑 Lighthouse / e2e                                       | 它们只在 `opened` 触发 → 开新 PR，或本地 `npm run lighthouse` / `npm run e2e`                 |
