# Agent Note: 工作区文件树显示 git 分支与逐文件状态

Status: implemented

[English](2026-08-27-workspace-files-git-status.md) | 中文

## 问题

工作区文件树（见[并列文件浏览器 Agent Note](2026-08-24-workspace-files-sibling-browser.zh.md)）能列出目录与文件，但不具备任何 git 感知能力：用户浏览一个受 git 管理的工作区时，无法在不离开应用的情况下看到当前分支或哪些文件有未提交的更改。`workspace.listEntries`／`workspace.readFile` 已经确立了"仅服务于文件树的宿主端原语"这一模式（`src/workspace-files.ts`，非沙箱化，直接调用 `node:fs/promises`）；git 状态需要以同样的形态补上。

## 决定

**新增第三个 RPC 方法 `workspace.gitStatus({ workspaceId })`，完全照搬 `listEntries`／`readFile` 已有的模板端到端实现。** 它贯穿这两者已经占据的同样六层：`api/workspace.ts`／`workspace.schema.ts` 中的 `WorkspaceApi`／`WorkspaceGitStatus` 类型与 zod schema、`RpcMethodMap` 的一行、`fetch/handler.ts` 的请求 schema 表、`fetch/client.ts` 的透传方法（`IApiClient.workspace.gitStatus` 及其响应值 schema 行），以及 `api-proxy.ts` 中解析 workspace 后委托给新宿主端原语 `src/workspace-git.ts` 里的 `workspaceGitStatus` 的处理器。与 `listEntries`／`readFile` 不同的是，请求不携带 `path`——git 状态是针对整个仓库一次性扫描的，而不是按浏览到的目录分别扫描（理由见下方"曾考虑的替代方案"）。

**`workspace-git.ts` 通过 `node:child_process.execFile`（promisify 包装）直接调用宿主自身的 `git` 可执行文件**，延续了 `workspace-files.ts` 已经为这个宿主原生、非沙箱化的界面确立的"直接调用 Node 原语，不经过能力接缝间接层"的姿态。共三次 git 调用：`rev-parse --show-toplevel` 解析出所在仓库的根目录（可能是工作区自身目录的祖先——工作区不必是仓库根）；`symbolic-ref --short HEAD` 读取分支名；`status --porcelain=v1 -z --untracked-files=all` 读取待处理更改。一个不在任何 git 工作树内的目录、或宿主机上根本没有 `git` 可执行文件，二者都归结为 `{ isRepo: false, branch: null, files: {} }`——这是正常结果，不是业务错误；本模块从不区分"不是仓库"与"无法判断"。

`-z`（NUL 分隔、绝不加引号的 porcelain 输出）是刻意的选择：默认的以换行分隔的形式，在 git 默认 `core.quotePath=true` 下会对任何含有 ≥ 0x80 字节的路径做 C 风格加引号，把非 ASCII 字节以八进制转义形式输出，而不是原样输出为文本——对于这个双语（`zh`／`en`）产品而言，中文文件名是日常输入而非边角场景，这是一个真实的正确性缺陷。`-z` 会原样输出每一条路径；一条重命名／复制记录会变成两个连续的、以 NUL 结尾的字段（新路径，随后是原路径），只保留新路径——也就是文件树当前展示的那个。每一条 porcelain 的 `XY` 状态对会折叠为一个展示字母（`M`／`A`／`D`／`R`／`C`，未跟踪的 `??` 记为 `U`）：优先取暂存区（索引）一侧的字母，否则取工作区一侧的字母。

**分支名使用 `symbolic-ref --short HEAD`，而非 `rev-parse --abbrev-ref HEAD`。** 后者在一个"未出生"的分支（刚 `git init`、尚无任何提交的仓库——这是真实且常见的状态，并非罕见情形）上会直接失败，因为没有可解析的提交；`symbolic-ref` 直接读取 HEAD 指向的引用目标，在两种情况下都能解析成功。分离头指针（HEAD 直接指向一个提交而非某个引用）没有分支名，按 git 自身的约定报告为字面量 `"HEAD"`。

**客户端与 UI 层的贯穿方式与相邻 props 完全一致。** `IWorkspaces` 新增 `listWorkspaceGitStatus`；`WorkspaceRuntime` 将其实现为一次简单的 `this.api.workspace.gitStatus(...)` 调用；`WorkspaceBrowserInjected`／`WorkspaceBrowser`／`SessionTree`／`FilesNodeProps` 均在 `listWorkspaceEntries`／`readWorkspaceFile` 旁新增匹配的 prop。`FilesNode` 在挂载时（以及 `workspaceId` 变化时）拉取一次 git 状态，卸载时中止——与 `useLevel` 目录列表钩子已有的"折叠后重新展开即重新拉取"生命周期完全相同，因为 `FilesNode` 本身会在其所属 Workspace 分组每次重新展开时重新挂载。始终可见的头部行（不受文件树自身内部展开开关的控制）在 `files` 非空时显示分支名与一个脏状态指示点（复用 `ui-primitives` 的 `StateDot`）；每一行文件在有待处理更改时，会在文件名后显示其状态字母，颜色沿用既有的 `--dsw-alias-state-{warn,success,error,business}-primary` 令牌区分。

`TestWorkspaces`（`test-support/client-runtime`）与 `FixtureApiClient`（`client/connection`）都实现了这个新方法——前者记录调用并默认返回 `isRepo: false`，后者由于其工作区树是合成的、从来不是真实的 git 工作树，因此始终报告 `isRepo: false`。

**目录行同样携带一个聚合脏状态标记**，只要该目录之下任意深度存在一个有待处理更改的文件——无论该层级是否被拉取过——就会显示。由于 `files` 本就通过一次拉取覆盖了整个仓库，目录行只需对同一个映射做一次简单的前缀扫描即可回答这个问题（`isUnderDirectory`，带路径分段边界校验，因此 `/ws/foo` 不会误匹配 `/ws/foobar/x.txt`），而不需要发起第二次请求；走入一个尚未展开的子树也不需要任何额外信号就能知道它内部有更改。

## 曾考虑的替代方案

- **引入一个打包的 JS git 实现（`isomorphic-git`、`simple-git`）而非直接调用外部命令。** 拒绝：仓库"优先使用已维护的依赖而非手搓实现"的政策，适用于依赖能删除自有代码的场景；这里自有代码只是几次 git 子进程调用与 porcelain 解析，其复杂度完全在 `workspace-files.ts` 已经用原生 `node:fs` 为同一界面所做的事情范围之内，而且能运行这个 GUI 的宿主机本就需要有 `git` 可执行，否则这个工作区也无从谈起。
- **使用默认的、以换行分隔的 `--porcelain=v1` 并自行解析 C 风格引号／八进制转义。** 在实测（用一个名为 `你好.txt` 的文件复现）确认 git 默认的 `core.quotePath=true` 会把非 ASCII 路径字节做八进制转义而非原样输出为文本后被拒绝——对中文文件名而言这是真实的损坏问题，不是假设情形。`-z` 彻底绕开了加引号的问题；不需要任何反转义逻辑。
- **使用 `git rev-parse --abbrev-ref HEAD` 获取分支名。** 拒绝：在刚 `git init`、尚无提交的仓库（未出生的 HEAD）上会直接失败——有一个专门针对该状态的测试捕捉到了这一点。`symbolic-ref --short HEAD` 在未出生分支与有历史记录的分支上都能解析成功。
- **把 git 状态调用限定在当前浏览到的子目录范围内（`git status <path>`）。** 拒绝：文件树可以独立展开到任意嵌套目录，而状态徽标必须在每一层都正确，且只来自头部一次拉取，而不是每展开一个目录就重新拉取一次；从仓库根扫描整个仓库并按绝对路径为结果建立索引，能统一服务于每一层。
- **复用 `packages/fs` 或 `packages/subprocess` 而非直接调用 `node:child_process`。** 拒绝：`packages/fs` 是面向模型工具的文件系统能力（沙箱化的智能体读写工具），`packages/subprocess` 是完整的智能体工具子进程接缝（标准输入输出方式、凭证擦除、按进程树的信号升级）——二者都是为与这个宿主原生、非沙箱化的 Web GUI 界面不同的消费方而构建的；而 `workspace-files.ts` 已经为这个界面确立了直接调用 Node 原语的先例。
- **目录行的聚合标记自带具体状态字母**（仿照文件行的徽标）而非一个单纯的脏状态圆点。拒绝：一个文件夹内可能同时存在新增、修改、删除等多种后代，选取某一个字母来代表这种混合状态会歪曲其余种类的存在；圆点只声明"内部有更改"，这一点在它显示时永远成立。
- **发起第二个、按目录范围划分的 RPC 调用（或客户端递归拉取）来回答"这个目录内部是否有更改"。** 拒绝：覆盖整个仓库的 `files` 映射已经能通过一次对既有数据的简单前缀扫描（`isUnderDirectory`）来回答这个问题——目录行不需要任何额外的拉取、聚合查询，也不需要提前展开尚未拉取的层级。

## 影响

- 新增文件：`packages/host/apiproxy/src/workspace-git.ts`，及其测试 `packages/host/apiproxy/tests/workspace-git.spec.ts`。
- 新增 RPC 方法 `workspace.gitStatus`，请求为 `{ workspaceId }`，响应为 `WorkspaceGitStatus { isRepo, branch, files }`——一个正常（非错误）的 `isRepo: false` 结果同时覆盖"不是仓库"与"没有可用的 `git` 可执行文件"两种情形。
- `IWorkspaces`、`WorkspaceBrowserInjected`、`FilesNodeProps` 均新增 `listWorkspaceGitStatus`；`TestWorkspaces` 与 `FixtureApiClient` 都实现了它（默认 `isRepo: false`）。
- `zh`／`en` 两侧均新增本地化键 `files.git.branch`、`files.git.dirty`、`files.git.folderDirty`、`files.git.status.{M,A,D,R,C,U}`。
- 每个改动到的文件在其所属包自身的测试套件中都达到 100% 的行／分支／函数覆盖率（`workspace-git.ts`、`FilesNode.tsx`、`api-proxy.ts`／`fetch/client.ts` 的接线部分）；`workspace-git.ts` 中有一条分支——调用方信号恰好在仓库根检查完成与分支名调用完成之间这段极窄的窗口内中止——被标记为 `v8 ignore`，理由是无法在测试中可移植地构造这种竞态，这与 `workspace-files.ts` 自身对其"扫描中途失败"分支已有的先例一致。`ui-workspace/src/client/index.ts` 与 `WorkspaceBrowser.tsx` 仍处于本次改动之前就已存在的 GUI 债务覆盖率豁免名单（`vitest.config.ts`）之内；本次在其中新增的仅是 prop 传递，不引入新分支。
- 早期草稿中，调用方信号在仓库根检查阶段中止时会被吞掉、直接归入普通的 `isRepo: false` 结果（`catch` 块把包括中止在内的一切都吞掉了）——这一问题在落地前被一个测试捕捉并修复：中止现在会重新抛出，并向上传播到 RPC 处理器的 `cancelled` 响应，与 `listEntries`／`readFile` 报告取消的方式保持一致。
