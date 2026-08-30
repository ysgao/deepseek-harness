# Agent Note: 工作区文件树的 Refresh 会从远端 fetch；Pull 只做 rebase

Status: implemented

[English](2026-08-30-workspace-files-git-fetch.md) | 中文

本记录建立在[拉取／推送按落后／领先数门控的决定](2026-08-30-workspace-files-git-pull-push-gating.zh.md)之上：那份记录让 Pull／Push 的可见性依赖于 `ahead`／`behind`，但这两个计数的新鲜度只取决于此前某次 fetch／pull／push 恰好留在本地远程跟踪引用里的内容——应用内并没有任何一处会自行主动 fetch。本记录补上了这个动作。

## 问题

一个仓库可能确实落后于其远端，但用户在应用内却无从得知：`ahead`／`behind` 是根据本地已知的引用计算得出（`git rev-list --left-right --count @{upstream}...HEAD`），而现有流程中的任何地方——挂载时、点击显式 Refresh 时、折叠再重新展开时——都不会调用 `git fetch`。以 `behind > 0` 为门控条件的 Pull 按钮，即便上游确实有等待中的提交，也永远不会出现，除非外部因素（终端里的一次 `git fetch`，或者此前一次应用内的 Pull／Push）恰好先更新了本地跟踪引用。在这同一个文件树所指向的仓库里手动运行一次 `git fetch`，之前一直隐藏的 Pull 按钮立即带着准确的计数出现了，这证实了计数本身是正确的——缺失的只是触发 fetch 的入口。

## 决定

**新增 RPC 方法 `workspace.gitFetch({ workspaceId })`，补全 `WorkspaceController` 上 `gitStatus`／`gitCommitAll`／`gitDiscardAll`／`gitPullRebase`／`gitPush` 已经建立的同一套 `@Remote` 方法模板。** 它委托给 `workspace-git.ts` 中新增的 `fetchRemote` 函数，该函数运行不带任何参数的 `git fetch`（默认远端下的每一个被跟踪分支），成功后解析为 `{ fetched: true }`。`git fetch` 从不触碰 `HEAD`、当前分支或工作树——它只更新远程跟踪引用（`refs/remotes/origin/*`）——因此不会产生冲突，也绝不会改变 `workspaceGitStatus` 的 `files` 映射所报告的任何内容；只有依据这些同一批引用计算出的 `ahead`／`behind` 可能因此变化。失败模式并不对称，且两种都是真实存在的：一个无法访问或配置错误的远端会抛出 `GitCommandError`，但一个完全没有配置任何远端的仓库会成功解析——这是 git 自身有文档记载的空操作（已通过实测验证）——`fetchRemote` 并不对此做特殊处理，只是如实报告 `git fetch` 自身报告的结果。

**文件树头部的 Refresh 控件会在既有的本地 git 状态重读之前调用 `fetchRemote`；其余任何触发点都不会。** `FilesNode` 的 `handleRefresh` 现在会先 `await fetchRemote(workspaceId)`，再调用它一直以来就会调用的同一个 `refreshGitStatus()`——即便 fetch 失败，它依然会在之后调用 `refreshGitStatus()`（本地已知的内容或许仍值得重新展示，例如自上次读取以来在终端里提交过一次），同时新增了一条 `fetchError` 提示，样式与既有的 `pullError`／`pushError`／`commitError`／`discardError` 提示条完全一致。其余每一处触发状态重读的路径——初次挂载、折叠再重新展开，以及提交／放弃／拉取／推送成功后的刷新——都与此前完全一样，直接调用 `refreshGitStatus()`，不做任何 fetch：这些都是由一个不相关的用户手势（展开树、提交、推送）触发的自动／隐式重读，在这些时刻意外发起一次网络调用（还可能带来凭据提示）只会比帮助更让人意外。Refresh 自身的 fetch 被刻意排除在头部共享的 `busy` 标志之外，且是双向的：由于 fetch 既不触碰工作树也不触碰索引，它可以与 Commit／Discard／Pull／Push 并行运行而不必等待它们；反过来也成立——Commit／Discard／Pull／Push 在一次 fetch 进行期间依旧保持可用。Refresh 只防范自身的重入，通过新增的 `fetchPending` 状态，在自身的 fetch 完成之前禁用 Refresh 按钮本身（不禁用其他触发点）。

**`pullRebase` 不再执行 fetch：它现在运行不带参数的裸 `git rebase`，而不是 `git pull --rebase`。** 不带 `<upstream>` 参数的 `git rebase` 会解析出与 `git pull` 自身相同的默认上游（`branch.<name>.remote`／`branch.<name>.merge`），因此这一改动完全保留了 Pull 原本要 rebase 到的那个分支——它只是去掉了 `git pull --rebase` 原本会先执行的那次隐式 fetch。这把"检查是否有更新"（现在是 Refresh 的职责）与"应用已知的更新"（Pull 的职责）解耦：在此之前，一次 Pull 点击可能会静默 fetch 到超出头部所显示 `behind` 计数的提交，rebase 的内容比用户看到并点击时所期望的更多。此改动之后，Pull 永远只会 rebase 到 Refresh 最近一次 fetch 已经找到的那些提交——展示出来的计数与 rebase 实际产生的效果永远不会出现分歧。如果在从未运行过 Refresh、或很久以前运行过 Refresh 的情况下点击 Pull，它就只会基于那个陈旧的本地上游引用做 rebase——这与 `ahead`／`behind` 自身已经具有的"与最近一次 fetch 保持一致"的约定完全相同。

## 曾考虑的替代方案

- **让 `gitStatus`（或 `aheadBehind`）在每次调用时都执行 fetch**，这样挂载、折叠再重新展开、Refresh 就都能报告准确的计数，而不需要一个单独的动作。已否决：`gitStatus` 会在文件树每次展开、以及每个写入类操作成功后的刷新中被读取——把所有这些都变成网络往返（还可能带来凭据提示），会重新引入 git-status 那份记录自己的"无实时推送通道"替代方案曾因另一个理由（一个常驻监视器）而否决的那种开销；一次显式的 Refresh 点击是接受这项开销的最窄范围。
- **既然已经有了独立的 `gitFetch`，仍然保留 `pullRebase` 为 `git pull --rebase`**（一次命令里同时完成 fetch 与 rebase），把二者视为独立但存在重叠的能力。已否决：如果 Refresh 与 Pull 各自都执行自己的 fetch，Refresh 刚展示出来的计数与 Pull 自己稍后那次 fetch 将要应用的提交，就有可能在两次点击之间因远端发生变化而悄悄产生分歧——把二者拆分为 fetch（Refresh）与仅 rebase（Pull），正是消除这种潜在分歧的关键。
- **为 Refresh 自身的 fetch 提供一个专门的 Cancel 操作**，仿照 Pull／Push 待定期间旁边的 Cancel 按钮。目前已否决：与 `pullRebase`／`push` 不同，Refresh 在此改动之前从未有过待定／取消语义，而一次单纯的 fetch 如果继续运行下去也没有工作树被修改的后果需要逃离——`fetchPending` 防止重入式的双击已经足够。
- **把 fetch 失败完全折叠为静默无提示**，理由是"无内容可报告"本就涵盖了"无法检查"。已否决：用户明确点击 Refresh 就是为了真正核实一次；失败时静默不做任何提示，看起来会与"你已经同步了"完全一样，可能掩盖一个真实、可操作的问题（凭据过期、网络中断）。

## 后果

- `packages/api/workspace-controller/src/types.ts` 新增 `WorkspaceGitFetchValue`（`{ fetched: true }`）；`workspace-git.ts` 新增 `fetchRemote` 函数；`WorkspaceFileCommands`／`WorkspaceController`／`ClientWorkspaceModel` 新增 `gitFetch` 方法；`IWorkspaces`／`WorkspaceController`（客户端）新增 `fetchRemote`；`WorkspaceBrowserInjected` 及其 `apply.ts` 接线新增 `fetchWorkspaceRemote`；`FilesNodeProps` 新增 `fetchRemote`，并按照 `pullRebase`／`push` 已有的方式贯穿 `SessionTree`／`WorkspaceBrowser`。
- `workspace-git.ts` 中的 `pullRebase` 现在调用 `git rebase` 而非 `git pull --rebase`；其 `GitCommandError` 的命令标签从 `'pull'` 改为 `'rebase'`（`GitCommandError` 自身 JSDoc 中列出的可能标签也新增了 `fetch`／`rebase`）。
- `FilesNode.tsx` 新增 `fetchPending`／`fetchError` 状态与一条新的错误提示；`handleRefresh` 现在是异步的（先 fetch，再刷新，错误处理只针对 fetch 这一段）；Refresh 按钮新增了 `disabled={fetchPending}`。
- 本地化键 `files.git.refresh`（`zh`与`en`两侧）现在会说明它会 fetch 但不做 rebase。
- 每一个既有的、实现了 `IWorkspaces`／`WorkspaceRemote` 的测试替身（`test-support/client-runtime`、本包自己的 `transport`／`model` 规格、`workspaces-service.client.spec.ts`）都新增了这个方法；`runtime.client.spec.tsx` 中 `TestWorkspaces` 的动词覆盖测试现在也会调用它。
- `workspace-git.host.spec.ts` 中既有的 `pullRebase` 测试，在需要真实的上游提交可供 rebase 或产生冲突的地方，现在会先调用 `fetchRemote`（一次没有事先 fetch 的裸 `pullRebase` 没有任何新内容可应用，已通过一条专门的断言直接验证）；新增的 `fetchRemote` describe 块覆盖了真实的远程跟踪引用更新、远端不可访问导致的失败、完全没有配置远端时的空操作成功，以及中止传播。
- 每个改动到的文件在其所属包的测试套件中都达到 100% 的行／分支／函数覆盖率。
