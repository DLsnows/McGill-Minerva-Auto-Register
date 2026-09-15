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

> **子支线的 PR 跑什么？答案是：只有 `claude-code-review.yml` 与 `pr-agent.yml` 两个 AI 评审，
> 除此之外没有任何 CI。** 这不是漏配，是策略：`ci.yml` / `branch-gate.yml` / `preview-e2e.yml` /
> `lighthouse.yml` 的 `on.pull_request.branches` 都**不包含** `feat/**`（GitHub 的 `branches`
> 过滤器只能列出具体分支名，无法表达 "base 不是长期分支"），所以子支线 PR 上这四个 workflow
> 根本不启动。质量由**本地 `npm run gates`** 保证，最终把关点是集成 PR → `dev`。

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
  **注意 npm 11**：`npm run gates -- --base origin/dev` 里的 `--base` 会被 npm 自己当成配置项吃掉
  （还会污染子进程的 `npm_config_base`）。脚本因此同时接受位置参数形式，但推荐用环境变量：
  `BASE_REF=origin/dev npm run gates`。
- 只跑单项就用原来的脚本：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build:web`、
  `npm run format:check:changed`、`npm run test:ci-scripts`、`npm run validate:workflows`。

## `ci.yml` 的 job

| Job                  | Runner          | 内容                                                                                                         | 为什么这个 runner                                                                                                                                          |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard`              | `ubuntu-slim`   | 判断 PR head 是否在**本仓库**（fork → `same_repo=false`），不跑任何仓库代码                                  | 见下文「fork 安全」；它是所有执行代码的 job 的前置条件                                                                                                     |
| `lint-and-typecheck` | `ubuntu-slim`   | `npm ci` → `npm run lint` → `npm run typecheck` → `npm run format:check:changed` → `npm run test:ci-scripts` | 便宜（1 vCPU），几分钟内跑得完                                                                                                                             |
| `unit-tests`         | `ubuntu-latest` | `npm ci` → `npm test`                                                                                        | **必须用 latest**：`ubuntu-slim` 有硬性 15 分钟上限且不可调；vitest 全套（shared + server + web/jsdom）可能被拦腰取消。显式 `timeout-minutes: 20` 说明意图 |
| `web-build`          | `ubuntu-slim`   | `npm ci` → `npm run build:web`                                                                               | 和 lint 同量级，deps 有 npm 缓存                                                                                                                           |
| `report`             | `ubuntu-slim`   | 汇总三个 job 的 Markdown 片段，发一条 sticky 评论                                                            | 每个 job 先把小结写成 artifact，`report` 按固定顺序拼接，所以评论形状永远一致                                                                              |

### fork 安全：先检查，再执行代码

`ci.yml` / `preview-e2e.yml` / `lighthouse.yml` 的 `pull_request` 事件对同仓库分支与 fork 分支**都会触发**。
如果直接 `checkout` PR head 再 `npm ci`，一个恶意 fork PR 只要改 `package.json` 的 `preinstall`
或 test/build 脚本，就能在我们自己的 runner 上执行任意命令。**`branch-gate.yml` 拦不住这件事**——
两个 workflow 是并行启动的，"事后拒绝"发生时代码早就跑过了。

所以每个 workflow 的第一个 job 都是 `guard`：它只比较
`github.event.pull_request.head.repo.full_name` 与 `github.repository`，输出 `same_repo`；
所有会执行仓库代码的 job 都写 `needs: guard` + `if: ... needs.guard.outputs.same_repo == 'true'`。

- **fork PR**：`guard` 通过并给出 warning，其余 job 全部 **skipped**（不是绿），runner 上不会执行 fork 的任何代码。
- **仓内 PR**：行为完全不变。
- **不用 `pull_request_target`**：那会把 secrets 与写权限交给不受信代码，比现状更危险。
- `scripts/ci/validate-workflows.mjs` 会**强制断言**这条不变量：一旦有人删掉某个 job 的 guard
  条件或 `needs: guard`，`npm run validate:workflows` 立刻失败并指出是哪个 job。
  （`branch-gate.yml` 不 checkout、不装依赖、只跑纯 shell，因此豁免。）

### prettier：只禁止**新引入**的违规

`npm run format:check`（全量）**当前是红的**：本仓库有约 37 个文件早于现行 Prettier 配置。
在一次 CI 改造 PR 里顺手全量格式化会淹没 diff，并且毁掉这些文件的 `git blame`。

但只做「检查本 PR 改动过的文件」也不够——**这些历史脏文件里就有产品支线天天在改的那些**
（`packages/web/src/pages/Settings.tsx`、`packages/web/src/i18n/index.ts`、
`packages/server/src/api/server.ts` …）。按「改动过就必须干净」判定，任何 PR 只要碰一下它们就必然红，
而让每条支线各自格式化这些文件，又会在互相 rebase 时制造大面积冲突。

所以判定口径是 **「不得新引入格式违规」**（`scripts/ci/format-check-changed.mjs`）：

| 文件状态                              | 判定                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| base 上**不存在**（新增文件）         | 必须格式干净                                                               |
| base 上存在，且 base 版本**干净**     | 必须保持干净                                                               |
| base 上存在，且 base 版本**本来就脏** | 记为 **pre-existing debt**，**不阻塞**，但会在输出与 JSON 报告里列出文件名 |

- 具体做法：对每个改动文件，先 `git show <base>:<path>` 取出 base 版本，写到保持目录结构与**原文件名**
  的临时文件（否则 Prettier 会套错 parser／配置），用同一份 `.prettierrc.json` 各跑一次 `--check`，
  再比较两侧结果。脚本注释里记录了三个必须注意的坑（临时文件丢配置、`package.json` 必须同名、
  base 版本要用同样的方式判定）。
- 退出码**只由新引入的违规决定**。历史债即使全部都是，也只报告、不失败。
- 历史债会以 `format-changed.json`（`CI_REPORT_PATH`）形式留给 CI，并在 sticky 评论里提示。
- 只想严格判定（例如清理完历史债之后）：`--no-base-compare` 即回到「改动过的文件必须全部干净」。
- 本地同样一条命令：`npm run format:check:changed`（或 `npm run gates` 里的 `format:changed`）。
- **判定范围分两种（`--mode`，默认按 `CI` 自动选）**：

  | 模式       | 何时用                                  | 变更集                                                               | 校验的内容                       |
  | ---------- | --------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
  | `worktree` | 本地 `npm run gates`（`CI` 未设时默认） | `<base>` ↔ **工作区**：已提交 + 已暂存 + 未暂存 + **全新未跟踪文件** | 磁盘上的文件内容                 |
  | `commit`   | CI（`CI=true` 时默认）                  | `<base>...HEAD`                                                      | git index（即推送的那个 commit） |

  为什么必须分：本地门禁如果只看提交，**未提交的改动——包括全新的未格式化文件——对 prettier
  完全不可见**，于是对一份还没格式化的代码报绿。这正是「假的绿灯」比没有门禁更糟的地方。
  `local-gates.mjs` 显式传 `--mode worktree`；`ci.yml` 显式传 `--mode commit`（两边都不依赖自动探测，
  这样范围在 workflow / 脚本里就能直接看到）。未跟踪文件用 `git ls-files --others --exclude-standard`
  收集——`git diff` 的任何变体都不会报告它们。

- **这个策略本身有回归测试**：`npm run test:ci-scripts`
  （`scripts/ci/format-check-changed.test.mjs`，9 个场景）。它在系统临时目录里建一次性 git 仓库，
  对**真实脚本**跑：

  | 场景                                    | 断言                                           |
  | --------------------------------------- | ---------------------------------------------- |
  | A 弄脏原本干净的文件                    | 必须失败                                       |
  | B 改动历史脏文件                        | 必须通过，并报为 pre-existing                  |
  | C 新增脏文件                            | 必须失败                                       |
  | D 全部干净                              | 通过，且报告里没有违规也没有历史债             |
  | E 改动 `.prettierignore` 里的文件       | 被 Prettier 跳过，不报违规                     |
  | F1 `commit` 范围看不到未提交文件        | 通过（**记录这个盲点**，证明 F2 测的是真东西） |
  | F2 `worktree` 范围下的全新未跟踪脏文件  | 必须失败                                       |
  | G `worktree` 范围下未暂存的改动弄脏文件 | 必须失败                                       |
  | H `worktree` 范围下的历史债             | 仍然不阻塞                                     |

  CI 与 `npm run gates` 都会跑它；同一个 npm script 还会跑 branch-gate 的 17 个晋升规则用例。

- 脚本自身**不做** `.prettierignore` 过滤：`git check-ignore` 只读 git 自己的 ignore 链
  （`.gitignore` / `.git/info/exclude`），**不读 `.prettierignore`**，用它过滤等于空操作（曾经写过，
  被评审指出后删掉）。忽略规则交给 Prettier 自己。
- 校验方式：把「待检查的内容」从 stdin 喂给
  `prettier --check --config .prettierrc.json --stdin-filepath <repo 相对路径>`。
  **必须用 `--stdin-filepath` 传真实的仓库相对路径**，这是被三个坑逼出来的做法：
  1. 把内容写到系统临时目录的副本上跑，Prettier 找不到 `.prettierrc.json`（静默用默认值：双引号、
     80 列）→ 所有文件都被判不合规；`.prettierignore` 的 `docs/plans` 这类模式也永远匹配不上，
     因为忽略模式是**相对忽略文件所在目录**解析的（`--ignore-path` 也救不了这一点）。
  2. 副本还会丢文件名语义：JSON 只有**名为** `package.json` 才套用其专属设置。
  3. `--stdin-filepath` 同时解决了「按 base 版本内容判定」——`git show <merge-base>:<path>` 的内容
     可以带着正确的路径/配置/忽略规则被检查。
     注意 `--stdin-filepath` 模式下 Prettier 即使 `--check` 也会把格式化结果打到 stdout，**只有退出码有意义**
     （0=合规或已忽略，1=需格式化，2=真实错误）。
- **`docs/plans` 已加入 `.prettierignore`**：那些是智能体工作文档（plan / spec / task brief /
  审计清单），满是 CJK 文本，而 Prettier 按显示宽度对齐 Markdown 表格列——重排一次就是几百行、
  零语义变化的 diff，之后每次编辑还会冲突。与既有的 `docs/superpowers` 同等对待。
  `AGENTS.md`、`README*.md`、`docs/*.md` 仍参与检查（AGENTS.md 的表格已按 Prettier 对齐一次）。

想真正还这笔债：单独开一个 `chore/format-repo` PR 跑 `npm run format`，在 `.git-blame-ignore-revs` 里
登记该 commit，然后把 `ci.yml` 的 prettier 步骤换成全量 `npm run format:check`（或保留本脚本并加
`--no-base-compare`）。

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
- **两条独立的判定**，缺一不可：
  1. **端点覆盖断言**（主判据）。假后端用 `onRequest` / `onResponse` 钩子把**每个端点的调用次数与
     状态码**记进 ledger，通过 `GET /api/__requests` 暴露；每条用例在自身断言之后校验
     「我依赖的端点被调用过 ≥N 次」且「任何 `/api/*` 都没有 4xx/5xx」且「假后端没有产生任何 5xx」。
     这条能抓到「某端点压根没被请求」和「端点开始报错」两类问题——只看控制台是抓不到前者的。
     动态路径按模板归并（`/api/targets/:id`、`/api/targets/:id/run`），否则计数会被 id 打散。
  2. **控制台哨兵**（辅助判据）。忽略列表**只**覆盖本环境里真正无法加载的外部资源：
     Google Fonts 样式表（`index.html` 引用它，runner 没有外网）、favicon，以及这些外部源的
     `net::ERR_*` 连接层失败。**不再忽略**通用的 `Failed to load resource` —— 后端返回 500 时
     Chromium 报的正是这一句，早先的宽泛忽略会让「无控制台报错」在应用完全损坏时照样通过。
- **这套安全网本身是可测的**：`E2E_FAULT_ROUTES=/api/budget npm run e2e` 会让指定路由返回 500，
  用来验证「端点坏掉时用例真的会失败」。实测两个负向场景都会红：
  - `/api/budget` 返 500 → `console.error: Failed to load resource: the server responded with a status of 500`；
  - 把期望的端点改成从未被请求的路径 → `endpoint coverage failed: expected >=1 call(s) to ... saw 0`
    （并打印完整 ledger 便于定位）。
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
dev     ← feat/* | feature/* | dependabot/*
```

`branch-gate.yml` 用纯 shell 检查 `github.base_ref` / `github.head_ref`（`runs-on: ubuntu-slim`，
不需要 checkout）。它**先拒绝 fork**：`github.head_ref` 只是分支名（不带 fork 前缀），
否则 fork 里同名的 `dev` 分支就能混过晋升链。

规则本身有**行为测试**（`scripts/ci/branch-gate.test.mjs`）：它把 workflow YAML 里那段 shell
原样取出来、用 bash 跑 17 个 (base, head, 来源仓库) 组合。不是复制一份规则来测，而是测真实那一段。

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

因为目标是 `dev`，这些 PR 会走 `ci.yml` + branch gate + 两个 AI 评审（`claude-code-review.yml`
已通过 `allowed_bots: 'dependabot[bot]'` 放行 bot 触发的 PR）。

**`dependabot/*` 被显式放行进 `dev`**：Dependabot 的分支名是 `dependabot/npm_and_yarn/...`，
而 branch gate 的 `dev` 规则原本只收 `feat/*` / `feature/*`。若不放行，**每一个依赖 PR 都注定
gate 失败**，同时还会白跑一遍全量 CI —— 那就把「没人管的依赖 PR」换成了「注定失败的依赖 PR」，
与把 `target-branch` 从 `prod` 改成 `dev` 的初衷直接矛盾。所以 `branch-gate.yml` 的 `dev` case 是：

```sh
case "$HEAD" in
  feat/*|feature/*|dependabot/*) ;;
  *) echo "::error::Only 'feat/*', 'feature/*' or 'dependabot/*' branches can merge into 'dev'. Got: '$HEAD'"; exit 1 ;;
esac
```

依赖升级仍然和别的 PR 一样需要维护者审阅后合并（`AGENTS.md`：不要自动合并任何 PR 到 `dev`）。
`prod` 依然**只**接受 `dev` / `staging`，所以 `dependabot/*` → `prod` 会被拒绝。

这条一致性由两处机器检查保证，删掉放行规则会立刻变红：

- `scripts/ci/branch-gate.test.mjs` —— 从 workflow YAML 里**提取真实的 shell 步骤**并用 bash 执行，
  跑 17 个 (base, head, 来源仓库) 组合（含 `dependabot/*` → `dev` 必须通过、`dependabot/*` → `prod` 必须拒绝）。
- `scripts/ci/validate-workflows.mjs` —— 静态断言：只要 `dependabot.yml` 的 `target-branch` 是 `dev`，
  `branch-gate.yml` 就必须出现 `dependabot/*`。

## 故障排查

| 现象                                                               | 原因 / 处理                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 子支线 PR 上没有任何 CI                                            | 按设计如此（base 不是长期分支，四个 workflow 的 `branches` 都不含 `feat/**`）。跑 `npm run gates`        |
| `format:check:changed` 报 `could not resolve a base revision`      | 浅克隆或缺 `origin/*`。`fetch-depth: 0` 已配好；本地执行 `git fetch origin` 或 `--base <ref>`            |
| `format:check:changed` 打印 `pre-existing formatting debt`         | 正常：这些文件在 base 上就不过 prettier，**不阻塞**。不要在本 PR 里顺手格式化它们                        |
| `format:check:changed` 报 `newly-introduced formatting violations` | 本次改动把某个原本干净的文件写脏了（或新增了脏文件）→ `npx prettier --write <列出的文件>`                |
| preview e2e 报 `Executable doesn't exist`                          | 本地缺版本匹配的 Chromium：`npm run e2e:install`（依赖升级后 Playwright 可能要新构建，报错里会写明路径） |
| preview e2e 报 `web build not found`                               | 先 `npm run build:web`（`npm run e2e` 已经串了这一步）                                                   |
| 想验证 e2e 的安全网还有效                                          | `E2E_FAULT_ROUTES=/api/budget npm run e2e` → 指定路由返 500，用例必须变红（实测会红）                    |
| Lighthouse 报 `Chrome` 找不到                                      | CI 用 `ubuntu-latest`（自带 Chrome）；本地用 `LH_CHROME_PATH` / `CHROME_PATH` 指定                       |
| Lighthouse 某路由显示「report 已写出但退出码非 0」                 | chrome-launcher 清理临时 profile 的竞态（Windows 常见）。报告仍然有效，评论里会标注降级                  |
| 想重跑 Lighthouse / e2e                                            | 它们只在 `opened` 触发 → 开新 PR，或本地 `npm run lighthouse` / `npm run e2e`                            |
| 依赖 PR 会不会被 gate 拦下                                         | 不会：`dependabot/*` → `dev` 已放行（见「Dependabot」一节）；`dependabot/*` → `prod` 仍拒绝              |
