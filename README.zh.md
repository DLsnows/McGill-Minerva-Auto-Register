# AutoRegister — McGill Minerva 选课自动注册

[English](README.md) · **中文** · [Français](README.fr.md)

一个在本地运行的网页应用,帮你盯着 McGill Minerva 的课程 section,一旦有空位
就自动帮你注册(或加入 waitlist 候补)。它复用你**已经登录的浏览器会话**(所以
不会重复触发 2FA 双重验证),按带抖动(jitter)的间隔轮询,把操作控制在学校每日
上限内,并根据每个 section 的座位数判断 注册 / 候补 / 不操作 —— 可以自动执行,
也可以只通知你。

> ⚠️ 这是给**你本人**注册用的个人自动化工具。请合理使用,并遵守 McGill 的使用
> 条款。下面有 **dry-run(演练)** 模式,可以在真正动手前安全地排练一遍。

## 第一次用?手把手安装教程(不需要任何命令行基础)

这一节从零开始带你走一遍 —— 你**不需要**懂怎么用终端。如果你以前做过类似的事,
下面简洁的 [环境要求](#环境要求) / [安装](#安装) / [运行](#运行) 几节就够了。

### 1. 安装 Node.js(一次性)

这个应用依赖 **Node.js** 运行。打开 **https://nodejs.org**,点那个大大的绿色
**LTS** 下载按钮,打开下载好的文件,然后一路点 **Next / 下一步**(默认选项就行)。
它会顺带装上 `npm`,后面的命令要用到它。没装 Node 的话,后面那些命令根本不存在。

### 2. 下载应用

1. 打开项目页面:**https://github.com/DLsnows/McGill-Minerva-Auto-Register**
2. 左上角的分支选择框应该显示 **`prod`** —— 这是默认分支,所以本来就是它。
   (要下载的就是 `prod` 这个版本。)
3. 点绿色的 **`< > Code`** 按钮,再点 **Download ZIP**。
4. 找到下载好的 `.zip`(一般在**下载 / Downloads** 文件夹里)。**Windows** 上
   右键它 → **全部解压**;**Mac** 上双击它。你会得到一个名字类似
   `McGill-Minerva-Auto-Register-prod` 的文件夹。把它移到好找的地方,比如**桌面**。

### 3. 在那个文件夹里打开终端

"终端"就是一个让你打命令的窗口。它需要"指向"应用所在的文件夹 —— 这正是 `cd`
("change directory / 切换目录")命令干的事。不想手敲一长串路径的话,
**把文件夹拖进去**最省事:

**Windows:**
1. 点**开始**菜单,输入 **PowerShell**,回车。会弹出一个窗口。
2. 输入 `cd` 再加**一个空格**(先别回车)。
3. 把应用文件夹从桌面**拖到 PowerShell 窗口里** —— 它会自动帮你把完整路径粘上去。
4. 按**回车**。左边那行字现在以文件夹名字结尾,说明你已经"进到"它里面了。

**Mac:**
1. 打开**终端 Terminal**(按 **⌘ + 空格**,输入 **Terminal**,回车)。
2. 输入 `cd` 再加**一个空格**。
3. 把应用文件夹**拖到终端窗口里**粘上路径。
4. 按**回车**。

### 4. 安装并启动(第一次)

下面每一行都单独输入,输完按**回车**,等它跑完再输下一行:

```bash
npm install                       # 下载应用需要的东西(一次性,约 1 分钟)
npx playwright install chromium   # 下载它要操控的浏览器(一次性)
npm run serve                     # 启动应用
```

应用运行期间,**让这些窗口一直开着**:这个终端窗口(它**就是**应用本体 —— 关了
应用就停了),还有你登录之后它弹出来的那个 Chromium 浏览器窗口(那是你的 McGill
会话 —— 关了自动化就被登出了)。可以最小化,但别关掉。

**想停止应用**的时候,点一下终端窗口,按 **Ctrl + C**(按住 **Ctrl**,再按
**C**)—— 这才是正确的退出方式。之后想再开,重新跑一次 `npm run serve` 就行。

> **以后每次**,你只要在文件夹里打开终端(第 3 步),跑 `npm run serve` 就够了。
> 前面两条安装命令只需要一次。

### 5. 在浏览器里打开

打开**任意**浏览器(Chrome、Edge、Safari……),访问:

**http://127.0.0.1:4575**

这就是应用了。接着按下面 [运行](#运行) 一节的步骤来 —— 登录、添加你要盯的课、
然后点 **Start all**。

## 环境要求

- **Node.js 22+** —— 它会顺带装上 `npm`。还没装 Node?去官网下载 LTS 安装包:
  **https://nodejs.org**。(没装 Node 的话,下面的 `npm` / `npx` 命令都不存在。)
- Playwright 的 Chromium 浏览器(一次性下载 —— 见安装)。

## 安装

```bash
npm install                       # 安装依赖
npx playwright install chromium   # 一次性:下载 Playwright 要驱动的 Chromium
```

> `npx playwright install chromium` 只下载应用需要的那个 Chromium 构建(不是三个
> 浏览器全装)。这是最靠谱的安装方式 —— 不管 workspace 怎么布局,在仓库根目录都能用。

## 运行

```bash
npm run serve
```

然后打开 **http://127.0.0.1:4575**,接着:

1. **Session** 标签页 → *Open browser & log in*。会弹出一个 Chromium 窗口;用
   McGill SSO 登录一次。(McGill 只允许**一个活跃会话** —— 在别处登录会把这个
   自动化挤掉。)
2. **Courses** 标签页 → 添加要盯的课。把鼠标悬停在每个字段的 `?` 上看说明;
   **Term** 是 Minerva 的学期代码(Winter = …01,Summer = …05,Fall = …09,
   比如 Winter 2027 = `202701`)。Faculty 是必填的(比如 `Faculty of Science`)。
3. **Settings** 标签页 → 轮询间隔和抖动、每日查询/注册额度、通知方式(桌面 /
   声音 / 邮件 —— 见 [`docs/EMAIL_SETUP.md`](docs/EMAIL_SETUP.md))、以及
   **Dry-run** 模式。
4. **Dashboard** → 点 **Start all** 开始盯课。(启动时每门课都是**暂停**状态,
   而且在你登录之前 *Start all* 是禁用的 —— 所以不点就不会轮询。你也可以在每张
   卡片上单独 **Pause / Resume** 暂停或恢复。)实时控制台会把每次
   轮询 → 判断 → 操作 都流式打出来,最新的在最上面,还有个 **Clear** 清空按钮。
   卡片上的 **⚡ Register now** 可以立刻对那门课尝试一次。

界面语言随时可以在顶栏切换(中文 / EN / FR)。

## Dry-run(演练)

在 Settings 里打开 **Dry-run**,可以对着真实的 Minerva 把整条流程排练一遍,
**但绝不会真的提交注册**。调度器照样登录、轮询、判断 —— 只是在本该注册/候补的
地方,改成打一条 `DRY-RUN: would REGISTER <CRN>` 的日志,并让那门课继续保持盯着。
盯着控制台确认它的行为符合预期,然后把 dry-run 关掉,就能让它来真的了。

## 工作原理

- **判断**:根据 `cap/act/rem` 和 `wlcap/wlact/wlrem` → REGISTER(有空位)、
  WAITLIST(有候补名额)、或 NO-OP(不操作)。
- **节奏**:一个基础间隔(默认 30 分钟)± 抖动,并会拉长以避免把每日**查询额度**
  (默认 100)和**注册额度**(默认 20)用光 —— 既显得像真人,也尊重学校的限制。
- **每门课**:`auto` 自动注册/候补;`notify` 只通知你。

## 排查问题

**点了 *Open browser & log in* 之后马上显示 "Logged out",而且没有弹出 Chromium
窗口。** 这说明 Playwright 的 Chromium 没装上。登录流程会真的去启动一个 Chromium
窗口;如果浏览器二进制文件不在,启动就会失败,会话直接退回 *Logged out*,也不会
有窗口。装一次浏览器再重试:

```bash
npx playwright install chromium
```

(如果你跑了 `npm install` 但跳过了 Playwright 的浏览器下载,这是最常见的原因。)

## 开发

```bash
npm run lint
npm run typecheck
npm run test          # Vitest(node 与 web/jsdom 两个 project)
npm run build:web     # 生产环境 web 构建(由服务器托管)
```

Node + TypeScript 的 monorepo(npm workspaces):`packages/{shared,server,web}` ——
Playwright(浏览器自动化)、Fastify + WebSocket(API)、React + Vite + Tailwind
(Synapse 主题,i18n)的界面。

设计与计划文档:[`docs/superpowers/`](docs/superpowers/)。
