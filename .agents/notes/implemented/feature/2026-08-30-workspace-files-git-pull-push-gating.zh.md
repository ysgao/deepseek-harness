# Agent Note: 工作区文件树的拉取／推送按钮按落后／领先提交数门控显示

Status: implemented

[English](2026-08-30-workspace-files-git-pull-push-gating.md) | 中文

本记录部分取代 [git 拉取／推送 Agent Note](2026-08-28-workspace-files-git-pull-push.zh.md) 中"无条件显示的图标按钮"这一决定及其"按 ahead/behind 门控"的替代方案；该记录仍然是底层 RPC 方法、变基中途的 Discard 恢复逻辑、两个手绘图标以及 native-command 调用方式的原理权威来源。

## 问题

此前只要头部显示了分支，Pull 与 Push 就会无条件渲染，这源自此前那份记录对"按 ahead/behind 门控"这一替代方案的明确否决（认为实时计算代价过高）。实际使用中，这让两个按钮与纯装饰性图标毫无区别：一个没有配置上游、或已经与上游同步的用户，看到的是与一个确实有提交需要同步的用户完全相同的两个图标——仅凭工具栏本身无法判断点击是否会有实际效果，也无法判断两个图标各自把数据移动到哪个方向（"把提交拉进来"还是"把提交推出去"）。

## 决定

**`WorkspaceGitStatus` 新增两个必填字段 `ahead` 与 `behind`**，均为 `number` 类型，由 `workspace-git.ts` 中新增的 `aheadBehind` 辅助函数通过 `git rev-list --left-right --count @{upstream}...HEAD` 计算得出（标准输出为 `<behind>\t<ahead>`，左右顺序与 `@{upstream}...HEAD` 操作数的顺序一致）。这条命令只比较本地仓库已经掌握的引用——本身不发起任何网络操作——因此此前那份记录对"实时推送通道"（持续运行的文件系统监视器，或每次渲染都执行一次 `git fetch`）的否决并不适用于此：`aheadBehind` 的新鲜度与最近一次 `git fetch`／`pull`／`push` 完全一致，其刷新方式与 `gitStatus` 现有字段完全相同（挂载时、点击显式的 Refresh 时，以及折叠再展开时）。一个没有配置上游的分支，或处于分离状态的 `HEAD`（二者都没有可解析的 `@{upstream}`），会让该 git 命令以非零状态退出，而不是报告零计数；`aheadBehind` 会捕获这种情况并解析为 `{ ahead: 0, behind: 0 }`，把"无内容可报告"与"检查过、确实没有"视为同一种显示结果。`workspaceGitStatus` 通过 `Promise.all` 让 `aheadBehind` 与既有的分支／porcelain 状态调用并发执行，"不是仓库"的提前返回分支也报告 `ahead: 0, behind: 0`。

**Pull 现在仅在 `behind > 0`（或一次拉取正在进行中）时才渲染；Push 仅在 `ahead > 0`（或一次推送正在进行中）时才渲染。** 这个"正在进行中"的额外条件确保某个按钮（及其相邻的 Cancel 控件）在自身操作进行期间始终保持可见，即使并发的一次状态刷新把计数重新计算为零也不例外。分支名与待处理更改数量徽章（`.gitChangedCount`）依旧保持无条件显示，与 git-status 那份记录建立的行为一致——这次改动只涉及 Pull／Push 的可见性，不涉及头部的其余部分。

**每个渲染出来的按钮，其提示文字现在都会写明自己的计数**（`files.git.pull`／`files.git.push` 的本地化字符串新增了 `{n}` 占位符——"拉取（变基）：{n} 个提交落后"／"推送：{n} 个提交领先"），并且只要计数为正，图标旁就会渲染一个小的数字徽章（新增的 `.gitAheadBehindCount` CSS 类，无样式修饰——没有背景色——不同于 `.gitChangedCount` 的胶囊样式，因为它紧挨着一个已经带有相同数字提示文字的图标）。该徽章本身不带 `title`——如果按钮与其相邻徽章都带上完全相同的提示文字，会产生两个具有相同无障碍名称的元素，这对用户和依赖 `getByTitle` 一类查询的测试都会造成歧义——按钮自身的 title 是这段文字的唯一来源。徽章的负左外边距（`-7px`）用于抵消 `.gitRefreshButton` 自身的内部留白（20px 的按钮包裹一个 14px 的图标，每侧大约留出 3px 的透明空间）再加上 `.gitSummary` 的 5px flex 间距——二者叠加起来，如果不做调整，图标图形与数字之间的间隙会显得过大。

**一次成功的推送现在会调用头部其他写入类操作成功后已经调用的同一个 `refreshGitStatus()`**，这取代了此前那份记录中"推送不会改变 `WorkspaceGitStatus` 报告的任何内容，因此无需刷新"的理由——那条理由是在 `ahead`／`behind` 尚未加入该类型之前给出的。如果没有这次刷新，一个已经满足（无需再推）的 Push 按钮（及其计数徽章）会一直陈旧地停留在界面上，直到用户自己注意到并点击显式的 Refresh 控件；推送通常会让 `ahead` 归零，因此在此处刷新能让按钮像本次改动之前满足条件的 Pull 按钮那样自行消失（Pull 出于改变工作树内容的原因，此前就已经调用 `refreshGitStatus()`）。推送依旧不会递增 `levelRefreshKey`——它不改变任何本地文件内容，当前展开的目录层级也就没有新内容需要重新拉取。

## 曾考虑的替代方案

- **保留一个共享但不带 title 的徽章，但仍从与按钮相同的 key 派生其无障碍名称。** 已否决：徽章上的任何提示文字都会与按钮的提示文字逐字重复（同一个本地化 key，同一个计数），这只会重新引入"两个元素、相同无障碍名称"的歧义，而这正是本次改动刻意要消除的问题；一个纯视觉性的数字，紧挨着一个已经带有标签的图标，并不需要拥有自己独立的标签。
- **通过一次实时的 `git fetch --dry-run`（或后台轮询）让计数也能反映用户尚未拉取到本地的提交。** 已否决：`gitStatus` 目前从不主动从远端拉取（git-status 那份记录自己的"无实时推送通道"替代方案已经否决了这项开销）；在此处再加入一次 fetch，会给这个原本一直即时、纯本地的状态读取引入凭据提示与网络延迟。让计数"与最近一次 fetch／pull／push 保持一致"，与 git 命令行自身在 `git status`／`git branch -vv` 中报告 ahead/behind 的方式一致。
- **把 `ahead`／`behind` 定义为 `number | null`**（用 null 表示"未配置上游"，与真正的零区分开）。已否决：文件树界面完全不需要区分"没有上游"与"与上游同步"——二者都意味着"不显示 Pull／Push 按钮"——而一个可空字段会强迫每一处消费方（包括每一个既有测试夹具）都要处理第三种状态，却没有任何与零不同的行为差异。

## 后果

- `WorkspaceGitStatus`（`packages/api/workspace-controller/src/types.ts`）新增必填的 `ahead: number` 与 `behind: number` 字段；仓库中该类型的每一处既有字面量——测试、夹具、test-support 运行时替身——都已更新以提供这两个字段（无仓库／已同步的默认值为 `ahead: 0, behind: 0`；在测试 Pull／Push 可见性或点击行为的地方使用正值）。
- `packages/api/workspace-controller/src/workspace-git.ts` 新增 `aheadBehind` 函数；`workspaceGitStatus` 现在会将其与既有的分支／porcelain 调用一并执行，并把结果展开进返回的 `WorkspaceGitStatus` 中。
- `GitStatusSummary`（`packages/client/ui-workspace/src/client/files/FilesNode.tsx`）分别以 `status.behind > 0 || pullPending` 与 `status.ahead > 0 || pushPending` 为条件门控 Pull 与 Push 按钮组，不再无条件渲染两者。
- `FilesNode.module.css` 新增 CSS 类 `.gitAheadBehindCount`（纯 flex／inline-flex 数字，无背景色，区别于胶囊样式的 `.gitChangedCount`）。
- 本地化键 `files.git.pull`／`files.git.push`（`zh`与`en`两侧）新增了 `{n}` 占位符；每处调用都传入对应的 `behind`／`ahead` 计数。
- `packages/client/ui-workspace/README.md`／`README.zh.md` 说明 Pull／Push 分别依据各自与上游相关的提交计数门控显示，并展示该计数。
- 每个改动到的文件在其所属包的测试套件中都达到 100% 的行／分支／函数覆盖率：`workspace-git.host.spec.ts` 新增了针对"无上游"与"分支已分叉"两种情形的真实远端覆盖；`FilesNode.client.spec.tsx` 新增了专门的可见性测试（已同步时两者都隐藏、已分叉时两者都显示并带各自计数、仅落后时只显示 Pull、仅领先时只显示 Push），同时更新了每一个既有 Pull／Push 交互测试的夹具与标题查找。
