# Agent 笔记：修复上游同步后 File 视图的 workspace 解析问题

Status: implemented

[English](2026-08-29-file-view-workspace-resolution-fixes.md) | 中文

## 问题

把 Files 树 / File 标签页功能移植到重构后的 `dsh-client-connection`/`dsh-api-gateway` 架构上（该重构以按领域拆分、带 `@Remote` 装饰器的服务取代了 `packages/host/apiproxy`，`packages/api/workspace-controller` 即其中之一）时，`packages/client/ui-conversation-files` 被落地为一个独立的包（见[将 Workspace 文件树接入应用内 File 标签页](2026-08-27-workspace-files-tree-file-tab-wiring.zh.md)），但实际运行该应用时，暴露出它在解析"文件属于哪个 Workspace"这件事上的两个独立缺陷——两者都未被移植过程本身已经全绿的 typecheck/lint/test/coverage 流程捕获：

1. `apply.ts` 在插件挂载时只读取一次 `ctx.get('workspaces')` 并将结果闭包捕获。`workspaces` 是一个可选的跨包服务，从未出现在该插件自己的 `inject` 数组里，因此无法保证 `ui-workspace` 的客户端服务在 `ui-conversation-files` 挂载时已经注册完毕。只要没注册，闭包捕获的值就会在整个插件生命周期内一直是 `undefined`：每一次 `readFile`/`gitStatus`/`getFileDiff`/`writeFile` 调用都会在任何 RPC 离开浏览器之前就被拒绝，既没有控制台报错（这是一次被妥善处理的 rejection），也没有服务端日志（请求根本没有发出）——File 标签页只会对每一个文件永远显示"无法读取此文件"。
2. 即便 `workspaces` 已经解析成功，所属 Workspace 的确定方式也是遍历 `workspaces.list.getSnapshot().items`，找出 `sessionIds` 包含当前会话的那一个——只要该会话尚未（或还没来得及）反映在目标 Workspace 的名单里，这个反向查找就会失败。而 Workspace 文件树（`FilesNode.tsx`）本身就持有自己的 `workspaceId` 属性——正是当前正在浏览的那个确切 Workspace——根本不需要这次推导；只有那种自身没有 Workspace 归属的调用方（比如聊天消息里的文件提及，只掌握 sessionId 和 `cwd`）才真正需要它。

## 决策

针对第 1 点：把 `ctx.get('workspaces')` 的读取从"在 `apply()` 时读一次"改为"每次调用时都重新读取"，这与本代码库中其他可选跨包服务已经采用的写法一致（`ui-chat` 和 `ui-workspace` 自己对 `conversationFileOpener` 的查找都是内联调用 `ctx.get(...)`，从不缓存）。

针对第 2 点：将请求方自身的 `workspaceId` 显式地端到端传递下去，只要它存在就直接使用，仅当它缺席时才回退到基于会话归属的推导：

- `ConversationFileOpener.openFile(sessionId, path, workspaceId?)` 新增可选的第三个参数。
- `FileOpenRegistry.request`/`PendingFileOpen`（`file-opener.ts`）在 `path` 和 `seq` 之外一并携带 `workspaceId`。
- `ConversationSessionInjected.openFile(path, workspaceId?)` 把 `{ path, workspaceId }` JSON 编码后写入 `conversation.view` 框架唯一的那个不透明 `focus` 字符串（`ConvViewOwnerProps.openView(view, focus)`——`focus` 本就被有意设计为每个视图自定义的不透明标识，因此这个改动完全留在 File 视图自身的注册逻辑内，无需改动框架）。
- `FileView.tsx` 解码这个负载（`OpenFileFocus`），并把这一对值保存进本地的 `openedPath`/`openedWorkspaceId` state，使其能像既有的 `openedPath` 一样，在重新渲染和后台仓库变更之间保持不变。
- `FileViewInjected` 的四个方法（`readFile`/`getGitStatus`/`getFileDiff`/`writeFile`）都把 `workspaceId: WorkspaceId | undefined` 作为第一个参数；`ui-conversation-files/apply.ts` 的解析函数在它存在时直接使用，仅当它是 `undefined` 时才回退到基于会话归属的推导。
- `ui-workspace` 的 `openFileInSession(sessionId, workspaceId, path)` 以及 `FilesNode.tsx` 的调用点，直接把文件树自身的 `workspaceId` 属性原样传递下去，使得 Files 树这条最常见的路径完全不再依赖会话名单的更新时序。

## 已考虑的替代方案

**把 `workspaces` 变成 `ui-conversation-files` 的必需 `inject` 依赖。** 已拒绝：理由与接线笔记中拒绝把 `conversationFileOpener` 设为必需依赖如出一辙——未组合 `ui-workspace` 的场景仍必须能让这个包正常加载，只是每次文件操作都会优雅失败，而不是让插件直接拒绝挂载。

**继续只用基于会话归属的推导，转而修复其时序/数据缺口。** 已拒绝：从 `ui-conversation-files` 这一侧，没有可靠办法保证某个会话在打开文件时已经反映在正确的 Workspace 名单里；而文件树本来就掌握着毫无歧义的答案——直接传递这个答案严格意义上更正确，而不只是修补时序。

**把 `ConvViewOwnerProps.openView` 的 `focus` 参数为所有视图都扩展成结构化的 `{ view, focus: unknown }` 形态。** 已拒绝：其余每一个 `conversation.view` 条目都把 `focus` 当作纯粹的不透明字符串；仅为了照顾一个视图更丰富的负载就扩宽框架类型，会波及所有既有视图的注册逻辑，却没有共同的收益。把 JSON 编码留在 File 视图自己的 `apply.ts`/`FileView.tsx` 内部，改动就只局限于真正需要它的那一个视图。

## 验证

`packages/client/ui-conversation-files/tests/apply.client.spec.ts` 新增一个用例，断言显式传入的 `workspaceId` 会完全绕过基于会话归属的推导（即便该会话并不在任何 Workspace 的名单里），与既有的"推导成功"和"推导失败"用例并存。`packages/client/ui-conversation-files/tests/FileView.client.spec.tsx` 新增一个用例，断言 focus 负载自带的 `workspaceId` 会传递到每一次注入调用，而不是使用会话推导出的值。`packages/client/ui-workspace/tests/FilesNode.client.spec.tsx` 与 `apply.client.spec.ts` 把 `openFileInSession`/`conversationFileOpener.openFile` 的调用断言更新为三参数形态。完整运行一次 `pnpm run test:coverage`（17,370 个用例通过，仅 `scripts/oxlint-contract.spec.ts` 中 1 个与本次改动无关的既有失败，由本沙箱环境的 `FORCE_COLOR=3` 引起）显示没有出现覆盖率阈值回归。

## 影响

无论插件挂载顺序如何，也无论被打开的会话是否已经反映在目标 Workspace 的名单里，从 Workspace 文件树打开的文件都能被 File 标签页可靠地读取、写入和对比差异。聊天消息中的文件提及（唯一一个自身没有 Workspace 归属的调用方）保留了此前那套更弱的、基于会话推导的回退行为——它仍可能因为某个会话尚未出现在任何 Workspace 名单里而解析失败，这是一个更窄、本就存在的局限，本次改动并未把它扩展到 Files 树这条路径上。
