# CI 与产品体验整备计划（2026-09-15）

> 集成分支：`feat/ci-and-ux-overhaul`（基座 = `dev`，即 `c134a80`）
> 终态：集成分支开**一个** PR → `dev`，停在可 preview 状态，**不自行合并**。是否合并由项目所有者审核决定。

---

## 1. 目标与范围

本次改动分八块：

| 代号 | 内容 | 子支线 |
|---|---|---|
| A | 参照 Synchain 补齐 CI / 质量门禁（含 preview e2e + Lighthouse，控成本） | `feat/ci-quality-gates` |
| B | 修复「预算进度显示错乱」报障 | `feat/budget-progress` |
| C | 修复「首次点击开始不轮询」报障 | `feat/start-polling` |
| D | 新增操作速度（操作间隔 + 抖动）设置 | `feat/pacing-controls` |
| E | 邮件通知 UI 下架、后端保留且强制关闭 | `feat/email-sunset` |
| F | Windows 一键不休眠开关（仅 Windows 显示，仅接电源生效） | `feat/keep-awake` |
| G | 添加课程表单标注必填 / 选填 | `feat/course-form-labels` |
| H | Dependabot 治理（9 个陈旧 PR + 新增分组配置） | 归入 A |

代码审计（60 条问题，见 `docs/plans/2026-09-15-audit-inventory.md`）**不在本次修复范围内**，等所有者逐条批准后另开批次。

---

## 2. 分支拓扑与 PR 流向

```
dev ──┬──────────────────────────────────────────────────────────────►
      │
      └─ feat/ci-and-ux-overhaul  (集成分支 / 唯一的 dev-PR 来源)
             ▲   ▲   ▲   ▲   ▲   ▲   ▲
             │   │   │   │   │   │   └── feat/course-form-labels
             │   │   │   │   │   └────── feat/keep-awake
             │   │   │   │   └────────── feat/email-sunset
             │   │   │   └────────────── feat/pacing-controls
             │   │   └────────────────── feat/start-polling
             │   └────────────────────── feat/budget-progress
             └────────────────────────── feat/ci-quality-gates  (先行)
```

- 子支线 PR 的 **base = `feat/ci-and-ux-overhaul`**，因此不触发全量 CI（`ci.yml` 只对 base∈{dev,staging,prod} 生效），但 **Claude review bot 与 pr-agent 一定跑**。
- 子支线合并前必须：本地跑通全部门禁 + **逐条回复所有 review comment**（含 Claude、pr-agent、以及所有人类/机器人评论），说明「已修 / 误报 / 不改+理由」。
- 全部子支线合入后，集成分支开一个 PR → `dev`，触发全量 CI，**停在那里等所有者 preview**。

---

## 3. 执行顺序（关键路径）

**第 0 步（串行，必须先完成）**：`feat/ci-quality-gates` → 合入集成分支。

原因：GitHub 对 PR 使用的是 **base 分支上的 workflow 定义**。子支线 PR 的 base 是集成分支，所以只有当集成分支上已经有完整的 `ci.yml`（含针对 `feat/**` base 的轻量检查）时，后续子支线 PR 才可能看到任何 CI。否则子支线 PR 只会跑 review bot。

**第 1 步（并行）**：`feat/budget-progress`、`feat/start-polling`、`feat/pacing-controls`、`feat/email-sunset`、`feat/keep-awake`、`feat/course-form-labels` 六条同时开工。每条都从**已含 CI 的集成分支**新建（`git rebase feat/ci-and-ux-overhaul`）。

**第 2 步**：逐条按「本地门禁 → 开 PR → 看全部 comment → 修 → 逐条回复 → 合并」推进。

**第 3 步**：集成分支 → `dev` 的 PR，附 preview 指引，停下等审核。

---

## 4. 任务分派

| ID | 分支 | 交付物 | 主要涉及文件 | 依赖 |
|---|---|---|---|---|
| **P1** | `feat/ci-quality-gates` | `ci.yml`（lint/typecheck/prettier-changed/test+coverage）、`branch-gate.yml`、`preview-e2e.yml`、`lighthouse.yml`、`.github/dependabot.yml`、本地门禁脚本、CI 文档 | `.github/workflows/*`、`scripts/ci/*`、`.github/dependabot.yml`、`docs/CI.md` | 无 |
| **P2** | `feat/budget-progress` | 预算「已用/上限」单一原子来源，消除跨快照减法 | `packages/server/src/budget/budget.ts`、`api/server.ts`、`packages/web/src/App.tsx`、`components/Ticker.tsx`、`lib/api.ts`、`pages/Settings.tsx` | P1 |
| **P3** | `feat/start-polling` | 「开始」立即轮询；主开关绑定真实引擎状态；error 终态可恢复 | `scheduler/scheduler.ts`、`api/server.ts`、`api/main.ts`、`web/pages/Dashboard.tsx`、`components/SchedulerToggle.tsx`、`components/CourseCard.tsx` | P1 |
| **P4** | `feat/pacing-controls` | `opPauseMs` / `opJitterMs` 设置，贯通到所有浏览器操作 | `shared/src/store-types.ts`、`server/src/util/pacing.ts`、`minerva/*-client.ts`、`web/pages/Settings.tsx` | P1 |
| **P5** | `feat/email-sunset` | 邮件 UI 下架，后端保留但强制关闭 | `web/pages/Settings.tsx`、`server/src/notifier/*`、`api/server.ts`、`shared/src/store-types.ts` | P1 |
| **P6** | `feat/keep-awake` | Windows 防休眠开关 + 电源状态展示 | `server/src/system/keep-awake.ts`、`api/server.ts`、`web/pages/Settings.tsx` | P1 |
| **P7** | `feat/course-form-labels` | 表单必填 `*` / 选填标注 + 校验提示 | `web/src/components/CourseForm.tsx`、`shared/src/store-types.ts`、`web/src/i18n/index.ts`（三语） | P1 |

### i18n 分工（避免同文件冲突）

`packages/web/src/i18n/index.ts` 的 **zh / en / fr 三份字典都必须同步**。各任务只新增自己命名空间下的键，不修改他人的键：

- P3：`scheduler.*`、`status.*`、`card.*`、`dashboard.*`
- P4：`settings.*`（仅 `pacing` 相关新键）
- P5：`settings.*`（仅 `email*` 相关键的增删）
- P6：`settings.*`（仅 `keepAwake*` / `power*` 新键）
- P7：`form.*`

合入顺序按 P3 → P4 → P5 → P6 → P7，出现冲突时由集成分支维护者解（不要跨任务互改）。

### 共享文件冲突预案

`packages/web/src/pages/Settings.tsx` 被 P4/P5/P6 同时改动；`packages/server/src/api/server.ts` 被 P2/P3/P5/P6 同时改动；`packages/shared/src/store-types.ts` 被 P4/P5/P6 同时改动。

处理原则：
1. 每个任务只做**追加式**改动，不重排既有代码块。
2. 合入顺序：P2 → P3 → P4 → P5 → P6 → P7。
3. 后合入的任务在开 PR 前先 `git rebase feat/ci-and-ux-overhaul` 解冲突，再重跑本地门禁。

---

## 5. 质量门禁

### 5.1 本地门禁（每条子支线合并前必跑）

```powershell
npm run lint          # eslint .
npm run typecheck     # tsc --noEmit（三个 workspace）
npm test              # vitest run（30 文件 / 166 用例）
npm run build:web     # vite build
npm run format:check:changed   # 仅检查本次改动文件（见 P1 产出）
```

### 5.2 CI 门禁

| Workflow | 触发 | 成本策略 |
|---|---|---|
| `ci.yml` | PR base ∈ {dev, staging, prod}；以及 base 为 `feat/**`/`feature/**` 时只跑 lint+typecheck+test（轻量） | 全部 `ubuntu-slim`；只有 coverage job 用 `ubuntu-latest` |
| `branch-gate.yml` | PR base ∈ {dev, staging, prod} | 1 个 job，秒级 |
| `preview-e2e.yml` | PR base = dev，且 `types: [opened]` | 仅在首次创建 PR 时跑一次 |
| `lighthouse.yml` | PR base = dev，且 `types: [opened]` | 同上；单次 runs=1 |

---

## 6. Dependabot 治理

现状：9 个 open PR 全部 base=`prod`（默认分支），全部 `UNSTABLE` —— 因为 `prod` 不在现有 CI 的 `branches: [dev, staging]` 里，所以只有 review bot 在跑，而 Claude review 持续失败。

处置：
1. 新增 `.github/dependabot.yml`：`npm` 生态、**分组**（`dev-dependencies` / `production-dependencies`）、每周一次、`open-pull-requests-limit: 3`、target-branch 改为 `dev`。
2. 关闭现有 9 个陈旧单包 PR（已被分组 PR 取代），并在关闭评论里说明原因。
3. 依赖升级本身（fastify / undici / nodemailer / react-router 等）由新的分组 PR 在 `dev` 上带着完整 CI 重新提出。

---

## 7. 风险与不做的事

- **不做**：把集成分支合并到 `dev`。必须由所有者审核后自行合并。
- **不做**：自动合并任何 PR 到 `dev`。
- **不做**：本次修复审计清单里的问题（等批准）。
- **风险**：`packages/web/src/i18n/index.ts` 与 `Settings.tsx` 是多任务交汇点 → 已用命名空间隔离 + 固定合入顺序缓解。
- **风险**：子支线 PR 默认不跑全量 CI → 每条子支线合并前必须在本地跑全门禁，并在 PR 描述里贴出本地门禁结果。
