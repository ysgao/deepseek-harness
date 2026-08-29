# Agent 笔记：将 Workspace 文件树接入应用内 File 标签页

Status: implemented

[English](2026-08-27-workspace-files-tree-file-tab-wiring.md) | 中文

## 问题

`ui-conversation` 暴露了一个可选服务 `conversationFileOpener`（通过 `ctx.get('conversationFileOpener')` 获取），其 `openFile(sessionId, path)` 会把某个 Workspace 文件停靠进当前会话的 File 标签页；该服务自身的模块文档已将"Workspace 文件树"点名为预期的第一个调用方。但 `ui-workspace` 的文件树（`FilesNode.tsx`）从未获得这次调用：其文件行的点击处理函数被硬编码为写入本地 `setPreviewPath` 状态,始终渲染 `FileViewer` 弹窗。于是无论当前是否有活跃会话，侧边栏中点击文件都只会打开一个悬浮预览窗口，而不是停靠进主区域的标签页。

## 决策

`WorkspaceBrowserInjected` 新增 `openFileInSession(sessionId, workspaceId, path): boolean`。`ui-workspace` 的 `apply` 将其实现为 `ctx.get('conversationFileOpener')?.openFile(sessionId, path, workspaceId) ?? false`，与 `chatFileMentions` 采用相同的可选服务写法。`SessionTree` 已经为自身的分组逻辑通过 `useSessions(s => s).current` 解析出当前会话 id；把这个 id 与新增的回调一起，沿着既有的 `WorkspaceBrowser` → `SessionTree` → `FilesNode` 属性链，与 `listWorkspaceEntries`/`readWorkspaceFile`/`openPath` 一并传递下去。`workspaceId` 是 `FilesNode` 自身的属性——即正在浏览的那个确切 workspace——直接传递下去，而不是由 File 视图一侧重新推导；这一直接 id 为何重要，见[修复上游同步后 File 视图的 workspace 解析问题](2026-08-29-file-view-workspace-resolution-fixes.zh.md)。

`FilesNode` 的文件打开处理函数现在优先尝试会话路由：当存在当前会话且 `openFileInSession` 返回 `true` 时，直接返回，不触碰本地状态。只有在没有当前会话，或该服务拒绝时，才回退到 `setPreviewPath`（即 `FileViewer` 弹窗）——无会话的"新建会话"视图，以及任何未组合 `ui-conversation` 的场景，行为保持不变。

## 已考虑的替代方案

**在 `FilesNode` 内部新增一个 hook 来解析当前会话 id。** 已拒绝：`SessionTree` 已经通过标准的 `useSessions` 框架 hook 计算出 `current`，用于自身的分组展开逻辑；复用这个属性无需新增 hook 或重复订阅。

**把 `conversationFileOpener` 变成必需的 `inject` 依赖。** 已拒绝：该服务被有意设计为可选（未组合 `ui-conversation` 的场景仍需能预览文件），而 `ui-workspace` 已经因类型需要依赖 `@deepseek-ai/dsh-client-ui-conversation`，无需再引入硬性运行时依赖边。

## 验证

`FilesNode.client.spec.tsx` 新增两个用例：服务接受时（断言 `openFileInSession` 收到路径且弹窗从未挂载）与服务拒绝时（回退到弹窗）；既有的无会话用例改为显式传入 `currentSessionId={undefined}`，行为不变。`apply.client.spec.ts` 新增用例，断言在 `conversationFileOpener` 被提供之前 `openFileInSession` 返回 `false`，提供之后则委托给它。

## 影响

当存在当前会话时，点击 Workspace 文件会停靠进该会话的 File 标签页，而不是弹出悬浮预览。`FileViewer` 弹窗仍然可达——且是唯一路由——仅当没有当前会话或该服务未被组合进来时。
