# AGENTS.md — 本仓库的协作规则

> 给在本仓库工作的自动化智能体的通用规则。人类贡献者也建议读一遍。

## 分支模型

```
dev ──┬─────────────────────────────────────────────────►  (长期)
      │
      └─ feat/<integration>            ← 集成分支，唯一的 dev-PR 来源
             ▲   ▲   ▲
             │   │   └── feat/<task-c>
             │   └────── feat/<task-b>
             └────────── feat/<task-a>
prod  ← 由维护者从 dev/staging 晋升
```

- `dev` / `staging` / `prod` 是长期分支，**只能由维护者推动**。
- 功能改动一律开 `feat/<name>` 分支。
- 子任务分支的 PR base 是集成分支，**不是** `dev`。

## 绝对不要做的事

1. **不要 push 到 `dev` / `staging` / `prod`**。
2. **不要自动把任何 PR 合并到 `dev`** —— 必须由维护者审核合并。
3. **不要修改 `.github/workflows/claude-code-review.yml` 或 `pr-agent.yml`**（评审基础设施）。
4. **不要提交** `data/`、`.env`、`.browser-profile/`、`screenshots/`、任何 Minerva 页面 HTML 样本。
5. **不要在没有任务授权时修改 `package-lock.json`**。

## 本地门禁（提交前必跑）

```powershell
$env:npm_config_cache = "<repo 上一级的 .npm-cache>"
npm run lint
npm run typecheck
npm test
npm run build:web
```

全部必须通过。改动行为时要**新增**测试用例，不能只靠既有用例。

## 测试与国际化

- 单元测试：`vitest`。node 侧在 `packages/{shared,server}/src/**/*.test.ts`，web 侧在 `packages/web/src/**/*.test.tsx`。
- 用户可见文案**一律走 i18n**：`packages/web/src/i18n/index.ts` 里的 `en` / `zh` / `fr` 三份字典必须同步，`en` 是类型基准（`const zh: typeof en`）。
- 新增 i18n 键时只动自己功能命名空间下的键，避免与其他分支冲突。

## CI 触发矩阵（详见 `docs/CI.md`）

| PR base                            | 跑什么                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dev` / `staging` / `prod`         | 全量 CI（lint / typecheck / prettier-changed / test / web build）+ branch gate；base=`dev` 时首次 opened 额外跑 preview e2e 与 Lighthouse |
| `feat/**` / `feature/**`（子支线） | **不跑全量 CI** —— 本地跑 gates；Claude review 与 pr-agent 照常跑                                                                         |

## PR 要求

- 标题用 Conventional Commits：`feat(scope): ...` / `fix(scope): ...` / `ci: ...` / `docs: ...`。
- 描述必须写：改了什么、为什么、本地门禁结果、风险与回滚、reviewer 重点。
- 合并前必须处理完 PR 上的**所有**评论（含机器人），逐条回复处置结论。

## 产品约定

- 本工具复用用户已登录的 Minerva 浏览器会话，是**单用户本地应用**。
- 所有浏览器操作之间要有人类化的随机间隔（见 `packages/server/src/util/pacing.ts`），这是反检测与尊重学校服务器的设计要求，**不要为了提高速度去掉它**。
- 涉及真实注册的代码路径必须保持 dry-run 可用。
