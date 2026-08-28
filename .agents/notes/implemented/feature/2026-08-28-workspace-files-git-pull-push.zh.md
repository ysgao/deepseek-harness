# Agent Note: 工作区文件树新增 git 拉取（变基）与推送

Status: implemented

[English](2026-08-28-workspace-files-git-pull-push.md) | 中文

## 问题

文件树的 git 工具栏（[git-status Agent Note](2026-08-27-workspace-files-git-status.zh.md)）已经能显示分支与状态，并提供"提交全部"／"放弃全部"，但配置了远端的用户在应用内没有办法与之同步——拉取或推送都得离开应用去终端操作。

## 决定

**新增两个 RPC 方法 `workspace.gitPullRebase({ workspaceId })` 与 `workspace.gitPush({ workspaceId })`，补全 `gitStatus`／`gitCommitAll`／`gitDiscardAll` 已经建立的同一套六层模板。** 两者都委托给 `workspace-git.ts` 中的新函数 `pullRebase` 与 `push`，二者以写入类操作相同的方式解析仓库根目录（`repoRootOrThrow`，在无法解析时抛出 `GitNotARepositoryError` 而不是悄悄不做——调用方以为已经成功的一次同步绝不能静默失败）。`pullRebase` 不带任何额外参数地调用 `git pull --rebase`：它作用于当前分支及其已配置的上游，没有覆盖项。`push` 会解析该分支已配置的远端（`branch.<name>.remote`），并推送一个显式的 `<remote> HEAD` refspec 而非裸的 `git push`——裸推送的实际作用范围取决于宿主机的 `push.default`／`remote.<name>.push` 配置（例如 `push.default: matching` 还会把每一个与远端同名、本地已分叉的其他分支一并推送出去），在这样配置的宿主机上会让"推送"这一动作在用户毫不知情的情况下悄悄扩大范围；没有配置远端的分支会回退为裸的 `git push`，两种情况下报告的都是同样的"未配置推送目标"失败。命令失败时抛出 `GitCommandError('pull', …)`／`GitCommandError('push', …)`，复用既有的 `git-not-a-repository`／`git-command-failed` `RpcErrorDetailsMap` 条目——两者本就是通用的，并未局限于 `gitCommitAll`／`gitDiscardAll`，因此不需要新增错误分类。两个 RPC 调用都使用 `AbstractApiClient.callUnary` 的 `'caller-signal-only'` 超时策略，与 `gitCommitAll`／`gitDiscardAll` 一致，因为拉取或推送是应当运行至完成（或由调用方自行取消）的网络操作，而不应受限于为本地读取设定的预算；文件树会把点击本身的 `AbortSignal` 一路传入这两个调用，使卡住的凭据提示或无法访问的远端可以从界面上取消，而不是永远挂起。

**变基冲突会让仓库处于变基中途；`discardAllChanges` 现在会识别这一状态，并运行 `git rebase --abort` 而不是其常规的 reset。** 变基期间，`HEAD` 会临时指向当前正在重放的提交，而不是该分支自己变基前的分支尖端——常规的 `reset` + `checkout -- .` 组合会把"放弃更改"作用在这个临时提交上，使分支处于分离状态、且冲突文件仍原样留在磁盘上。`discardAllChanges` 现在会先检查 `isRebaseInProgress`（即 `.git` 下是否存在 `rebase-merge`／`rebase-apply` 状态目录，通过 `rev-parse --git-path` 定位，并相对仓库根目录解析——因为 `--git-path` 打印的是相对于 `-C` 目标目录、而非本进程自身工作目录的路径），再决定采用哪种恢复方式：变基中途时运行 `git rebase --abort`，一步恢复该分支变基前的分支尖端与工作树；否则走原有路径。这使文件树既有的"放弃全部"控件同时充当了拉取冲突的恢复操作——不需要新增界面元素——其确认对话框的说明文字也点出了这种情形。`classify()` 也新增了专门的 `X` 状态码，用于标记未合并（冲突）的 porcelain 组合（`DD`／`AU`／`UD`／`UA`／`DU`／`AA`／`UU`，在 `??` 之前判断），使冲突显示为"冲突"而不是与普通新文件混在同一个 `U`（"未跟踪"）标签下——这两者原本在文件树里无法区分，而"放弃"操作"未跟踪文件不受影响"的承诺，对一个冲突文件其实并不成立。

**客户端与界面接线沿用 `commitAllWorkspaceChanges`／`discardAllWorkspaceChanges` 的方式。** `IWorkspaces` 新增 `pullRebaseWorkspace`／`pushWorkspace`；`WorkspaceRuntime` 把两者都实现为对 `this.api.workspace.{gitPullRebase,gitPush}(...)` 的一次简单调用；`WorkspaceBrowserInjected`／`WorkspaceBrowser`／`SessionTree`／`FilesNodeProps` 都新增了对应的 props（`FilesNodeProps` 上是 `pullRebase`／`push`，与那里已有的更短的 `commitAllChanges`／`discardAllChanges` 命名一致）。

**Pull 与 Push 是无条件显示的图标按钮，不同于只在存在待处理更改时才出现的 Commit／Discard。** 是否有内容可拉取或可推送，并不取决于 `GitStatusSummary` 手头已有的本地 `files` 更改映射——只有一次实际的网络往返才能回答这个问题，而这个功能刻意没有加入这种往返（见"曾考虑的替代方案"）——因此两个按钮只要头部显示了分支就会渲染，位置排在 Discard 之后、既有的 Refresh 控件之前。两者各自拥有自己的 `pending`／`error` 状态（`pullPending`／`pullError`，`pushPending`／`pushError`）；一个派生出的 `busy` 标志（`discardPending || discardConfirming || pullPending || pushPending`）会在其中任意一个运行时禁用其余全部写入触发器（Commit、Discard，以及 Pull／Push 中未处于进行状态的那一个），因为这四个动作都会修改同一个 git 工作树／索引，并发的子进程会相互竞争。某个动作自身待定期间，Pull／Push 还会各自在其自身已禁用的触发按钮旁再渲染一个保持可用的 Cancel 按钮（点击即中止对应的 `AbortSignal`）——一个纯粹禁用的图标不会给一次卡住的网络调用留下任何退出方式。一次拉取失败也会像成功一样刷新 git 状态并递增 `levelRefreshKey`，因为变基冲突改变工作树内容（产生未合并文件）的程度并不亚于一次干净的变基——这正是让"放弃全部"作为可见恢复操作显现出来的原因。开始四个动作中的任意一个（或点击 Refresh）都会清除全部陈旧的错误提示，而不仅是自己那一条，这样一个已经在终端里解决掉的问题就不会让一条旧的提示一直钉在头部下方。

**一次成功的 Pull 会刷新 git 状态并递增 `levelRefreshKey`；一次成功的 Push 两者都不做。** 变基可能改变工作树文件内容，正如提交或放弃一样，因此 Pull 需要 `commitAllChanges`／`discardAllChanges` 已经触发的同一种"重新挂载当前展开的层级"处理。Push 绝不会触碰本地工作树，`WorkspaceGitStatus` 也没有可供它更新的领先／落后字段，因此推送成功后没有什么需要刷新。

**两个新的手绘图标**，风格与既有的 14px 描边风格（`strokeWidth 1.3`，圆角端点）`IconArrowUpOutline14`／`IconUndoOutline14` 一致，紧随其后加入 `ui-primitives`：`IconArrowDownOutline14`（Pull）——`IconArrowUpOutline14` 路径的竖直镜像，基线在顶部而非底部；以及 `IconChevronDuoUpOutline14`（Push）——两个堆叠的向上箭头。Push 刻意不复用 `IconArrowUpOutline14`：该图形在同一个工具栏里已经是 Commit 的图标，若 Push 也用它，两个不同的动作在同时显示时（也就是同时存在待处理本地更改时）会看起来完全一样。Cancel 复用既有的 `IconCloseFill14`（已经是 GitCommitInput 自己的 Cancel 图形），而不是再新增第三个图标。

**`workspace-git.ts` 改为通过共享的 `dsh-native-command` 运行器**（`runNativeCommand`，该包内原生路径打开器已在使用）调用 git，而不是本地手搓的 `promisify(execFile)`，从而免费获得其 Windows 隐藏控制台窗口与共享的中止传播行为；一个轻量的 `runGit` 包装函数在调用方未提供 signal 时用一个永不触发的 controller 兜底，因为本模块中的每个函数都保持 `signal` 为可选，而 `runNativeCommand` 本身要求必传。

**测试针对真实的 git 远端与真实的冲突，而非桩实现。** `workspace-git.spec.ts` 新增了 `initBareRemote`／`cloneRepo` 辅助函数，会 `git init --bare` 出第二个临时目录并克隆进被测的工作副本，使 `pullRebase` 有真实的上游可拉取、`push` 有真实的远端可落地提交——变基冲突通过在两侧对同一文件做出分叉更改来触发，非快进推送通过在推送方尚未推送之前就让远端从其身下分叉来触发，而显式 refspec 这一修复点则通过设置 `push.default: matching` 并搭配第二个已分叉、绝不能被一并推送的分支来验证。

## 曾考虑的替代方案

- **把 Pull／Push 的可见性绑定到领先／落后计数上**，就像 Commit／Discard 绑定在 `changedCount > 0` 上一样。已否决：计算这个值要么需要在每次文件树渲染时都做一次实时的 `git fetch --dry-run`／`rev-list` 往返（与 `gitStatus` 自己的"曾考虑的替代方案"一节已经否决的、其刷新机制"没有实时推送通道、没有常驻文件系统监视器"的成本相同），要么就得信任一个可能过时的本地猜测；像 Refresh 一样无条件显示两个按钮，两种成本都不需要。
- **Push 复用 `IconArrowUpOutline14`**，理由是"推送"与"提交"在语义上都是"向上发送"。已否决：同一个图标在同一个工具栏里代表两种不同含义（一次代表 Commit，一次代表 Push），一旦两者同时可见就会造成实实在在的困惑，而不仅仅是重复。
- **为 Push 添加确认对话框**，仿照 Discard 破坏性操作的 `Modal`。已否决：推送可以从远端一侧撤销（再推一次，或者 revert），而且 git 本身默认就会拒绝非快进推送——不存在确认对话框能有意义地保护的"找回丢失工作"情形，这一点与 Discard 不可逆的本地覆盖不同。
- **专设一个"中止变基"按钮**作为拉取冲突的恢复操作，而不是把它并入 Discard-all。已否决：这会在工具栏里重复出现一个破坏性操作控件，而"放弃全部、回到干净状态"本来就是中止一次进行中的变基的确切含义；另设一个按钮只会迫使用户去判断当前状态该用哪一个、外观又相似的破坏性控件。
- **在待定期间直接把 Pull／Push 的触发按钮本身换成 Cancel 按钮**，而不是在一个已禁用的触发按钮旁再渲染一个 Cancel。已否决：这会破坏工具栏已经为全部四个写入动作建立起来的"按钮待定时保持原位并禁用"这一视觉一致性，却相较于旁加一个按钮没有任何行为上的收益。

## 影响

- `packages/host/apiproxy/src/workspace-git.ts` 中新增函数 `pullRebase`、`push`、`currentRemote`、`isRebaseInProgress`；`discardAllChanges` 依据 `isRebaseInProgress` 分支；`classify()` 新增了 `X`（未合并／冲突）状态码。新增 RPC 方法 `workspace.gitPullRebase`／`workspace.gitPush`，请求为 `{ workspaceId }`，响应为 `{ pulled: true }`／`{ pushed: true }`，两者都会抛出 `git-not-a-repository`／`git-command-failed`（未新增 `RpcErrorDetailsMap` 条目；其 JSDoc 现在点名了全部四个 git 写入方法，而不再只是 `gitCommitAll`／`gitDiscardAll`）。
- `IWorkspaces`、`WorkspaceBrowserInjected` 与 `FilesNodeProps` 都新增了 `pullRebaseWorkspace`／`pushWorkspace`（`FilesNodeProps` 上是 `pullRebase`／`push`）；`TestWorkspaces` 与 `FixtureApiClient` 都实现了这两个新方法（fixture 没有真实的 git 工作树，走的是 `gitCommitAll`／`gitDiscardAll`／`gitFileDiff` 已经在用的同一条 `git-not-a-repository` 错误路径）；`runtime.client.spec.tsx` 里 `TestWorkspaces` 自己的动词覆盖测试现在也会调用这两个方法。
- `ui-primitives` 新增两个手绘图标：`IconArrowDownOutline14`、`IconChevronDuoUpOutline14`（无 Figma 来源）；图标集合回归测试里硬编码的总数从 73 变为 75。
- `zh` 与 `en` 中都新增了本地化键 `files.git.pull`、`files.git.push`、`files.git.status.X`；`files.git.discardConfirmDesc` 现在点名了变基中止这一情形。
- `workspace-git.ts` 不再直接导入 `node:child_process`／`node:util`；改为依赖 `@deepseek-ai/dsh-native-command`（经由原生路径打开器，该包本就已声明这一依赖）。
- 每个改动到的文件在其所在包的测试套件中都达到 100% 的行／分支／函数覆盖率；`commitAllChanges`／`discardAllChanges` 已经记录的那种狭窄的"信号在仓库根目录检查结束与 git 子进程调用结束之间中止"窗口，对新增的 `rebase-abort` 与 `currentRemote` 捕获点同样按相同方式标记为 `v8 ignore`，因为无法在测试中可移植地复现竞态。
- `packages/host/apiproxy/README.md` 与 `README.zh.md` 在本次改动中一并配对（本功能领域的翻译配对不再推迟到后续提交）。
