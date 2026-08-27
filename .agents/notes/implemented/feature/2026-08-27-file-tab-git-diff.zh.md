# Agent Note: 会话 File 标签中的并排 git diff

Status: implemented

[English](2026-08-27-file-tab-git-diff.md) | 中文

## 问题

会话 File 标签（见[作为会话标签页的文件预览](2026-08-26-file-preview-conversation-tab.zh.md)）始终只显示文件的当前内容，完全不具备任何 git 感知能力——尽管与它并列的 Files 树（见[逐文件 git 状态](2026-08-27-workspace-files-git-status.zh.md)，构建在[并列浏览器](2026-08-24-workspace-files-sibling-browser.zh.md)基础之上）早已追踪并展示哪些文件发生了更改。`host-apiproxy` 中也完全没有任何 diff 计算：现有的唯一 diff 呈现面，`ui-primitives` 中的 `DiffBlock`，是从模型工具调用的 `FileDiff` hunk（`packages/fs/tool-fs/src/diff.ts` 的 `computeHunkDiffs`）渲染出一张先删除后新增的堆叠式 chat 卡片，而不是来自 git，并且是为紧凑的内联卡片而构建的，不是为这种专门的全文件视图而构建的。

## 决定

**新增宿主能力 `workspace.gitFileDiff({ workspaceId, path })`**，在 `packages/host/apiproxy/src/workspace-git.ts` 与 `src/api-proxy.ts` 中沿用既有的 `workspace.gitStatus`／`gitCommitAll`／`gitDiscardAll` 模式（见 [git-status Agent Note](2026-08-27-workspace-files-git-status.zh.md)）。它返回 `{ oldText: string | null, newText: string | null }`——两侧都是完整文件文本，而不是限定上下文的 hunk，因为这是一个专门的全文件视图（`ReadBlock` 在同一个标签页中本就毫无上限地展示整个文件）。`oldText` 来自 `workspace-git.ts` 中新增的 `workspaceFileAtHead(path, filePath, signal)`（`git show HEAD:<repo-relative-path>`，把任何非中止失败都折叠为 `null`——新建／未跟踪／从别处重命名而来，或者是一个未出生的分支，全都归结为"没有已提交的 blob"，彼此不作区分）。`newText` 复用既有的 `readWorkspaceFile`／`workspace.readFile` 机制，把 `directory-unreadable` 折叠为 `null`（文件已从工作树中消失——这是一种预期内的 diff 状态），而 `file-too-large` 仍然作为它自己的错误呈现。与 `gitStatus` 静默返回的 `isRepo: false` 不同，非仓库工作区在这里会以 `git-not-a-repository` 明确报错失败（与写入类操作的立场一致）：没有仓库的 diff 没有意义，不是一种合法的空状态。

**`ui-primitives` 中新增客户端原语 `SideBySideDiff`**，采用 git 风格的两栏布局（左旧右新），每栏各自带有行号槽——是 `DiffBlock` 堆叠式卡片的并排对应物。它在客户端把 `diffLines`（`diff` 包，已经通过 `tool-fs` 与 `ui-trajectory` 成为仓库依赖）的输出对齐成行：宿主发送原始文本，客户端计算行对齐，与 `readFile`／`ReadBlock` 在普通视图中已经采用的分工完全一致。一个删除块紧跟一个新增块（即一次替换）会逐行配对；较长一侧多出的行单独成行，另一栏留空。没有语法高亮，也没有高度上限——与 `DiffBlock` 自身"不做高亮"的选择一致，也因为这个视图本就是一个专门的全文件呈现面，而不是需要折叠的内联卡片。

**`FileView`（`ui-conversation`）新增一个 View／Diff 切换控件**，只在打开的路径是 `kind: 'text'` 且存在待处理 git 更改时显示（`Object.hasOwn(gitStatus.files, path)`——包括 `U` 未跟踪代码，因为一个未跟踪文件相对于"无"仍然能有意义地呈现为"全部新增"的 diff）。`FileViewInjected` 新增 `getGitStatus`／`getFileDiff`，在 `apply.ts` 中通过 `readFile` 本就使用的同一个 workspaceId 解析闭包接线（提炼成一个共享的 `resolveOwningWorkspaceId` 辅助函数，避免把这个查找逻辑重复写三遍）。git 状态在每次打开路径时只拉取一次（用于决定切换控件是否可见）；diff 本身惰性拉取，只在用户切换到 Diff 模式时才拉取——而不是每次打开普通视图都拉取。没有实时刷新：文件树自身的显式刷新控件是未来后续工作的先例，本次改动并不重复实现它。

新类型 `WorkspaceFileDiff` 贯穿 `WorkspaceGitStatus` 已经在用的同一条五包重新导出链：`host-apiproxy`（`api/workspace.ts` → `api/index.ts`）→ `client/connection`（`api.ts` → `index.ts` → `fixture.ts`）→ `api/remotes` → `client/runtime`（`contract/workspaces.ts` 加 `workspaces/service.ts` 新增的 `getWorkspaceFileDiff`）→ `@deepseek-ai/dsh-client-runtime/client`。`IWorkspaces` 的另外两个实现方（`test-support/client-runtime` 的 `TestWorkspaces` 替身，以及 `client/connection`／`client/runtime` 的 `tests/` 中的协议测试替身）都新增了匹配的方法，使该接口在编译期依旧保持完备。

## 曾考虑的替代方案

- **在宿主端计算限定上下文的 hunk**（复用 `computeHunkDiffs` 的 `structuredPatch` 模式）而不是发送完整文本。拒绝：并排视图需要整个文件（与 `ReadBlock` 在同一标签页中本就无上限的姿态一致），而带上下文的 hunk 是 `DiffBlock` 紧凑 chat 卡片所需要的形状，不是这个专门的全文件视图所需要的——复用它意味着还要在客户端从 hunk 反推出完整文本，却没有任何好处。
- **对 `git diff` 自身的文本输出做 diff，而不是分别抓取两侧的完整文本。** 拒绝：把统一 diff 格式的文本重新解析为结构化的行，这与 `diff` 包本就能在两个纯字符串上正确完成的工作重复，而且宿主仍然需要单独读取工作树来做二进制检测／大小限制，因此并没有省下什么。
- **只要文件有更改就自动显示 diff，而不是提供一个可选的切换控件。** 拒绝：这会改变既有普通视图路径的默认行为，且除了重新打开文件之外没有回退的办法，还会迫使每一次打开已更改的文件都要付出一次 diff 拉取的代价，即便阅读者只是想看当前内容。
- **从 git 状态配对的重命名记录中解析出重命名前的旧路径**，使 `R`／`C` 文件能正确呈现 diff，而不是显示为"全部新增"。推迟：`workspace-git.ts` 的 porcelain 解析器本就丢弃了配对的原始路径字段（`workspaceGitStatus` 自身的文档注释已说明这一点），把它贯穿起来会触及 status 的协议格式（wire format），而 v1 选择在不支持它的情况下先行发布；已在 `packages/host/apiproxy/README.md` 中记为已知限制。

## 影响

- `WorkspaceApi`／`IWorkspaces` 都相应扩宽（`gitFileDiff`／`getWorkspaceFileDiff`）；根据 `packages/CLAUDE.md` 的能力 seam 规则，这次设计同时面向两个当前消费方（今天的 `ui-conversation` File 标签；Files 树是一个合理的未来调用方），而不是只围绕一个调用点定制。
- `ui-primitives` 新增一个依赖 `diff`（`tool-fs` 与 `ui-trajectory` 早已以同样的方式使用它，因此对整个 monorepo 而言并未新增供应链风险面）。
- 一个重命名／复制文件的 diff 会显示为"全部新增"而不是跟随重命名，并且只有 `kind: 'text'` 文件才会提供切换控件（v1 排除二进制／Markdown／图片）——两者都已记录在 `packages/host/apiproxy/README.md` 的 Known Limitations 中。
- `host-apiproxy`、`test-support/client-runtime` 的 `workspaces.ts`，以及 `ui-primitives` 的 `SideBySideDiff.tsx` 在各自包自身的测试套件中都达到 100% 的行／分支／函数覆盖率（两处窄窗口的 `signal.aborted` 二次检查——两次连续、都可能失败的 git／fs 调用中的第二次——被标记为 `v8 ignore`，与 `workspace-git.ts` 自身既有的针对 `commitAllChanges`／`discardAllChanges` 的窄窗口防护保持一致）；`ui-conversation/src/client/*` 仍处于本次改动之前就已存在的 GUI 债务覆盖率豁免名单（`vitest.config.ts`）之内，不过 `FileView.client.spec.tsx` 依然为切换控件新增了行为测试。
