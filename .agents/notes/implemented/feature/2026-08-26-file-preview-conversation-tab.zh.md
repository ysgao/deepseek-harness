# Agent Note: 文件预览以会话标签页而非浮动弹窗打开

Status: implemented

[English](2026-08-26-file-preview-conversation-tab.md) | 中文

## 问题

工作区文件树（见[并列文件浏览器 Agent Note](2026-08-24-workspace-files-sibling-browser.zh.md)）此前把每个文件都在 `FileViewer` 中打开——一个铺满整页的 `Modal` 对话框，会盖住侧栏与对话区，用户也无法在阅读文件的同时把它留在对话旁边。主对话区其实已经有一套现成的标签系统可以承载这类替代视图：`ui-conversation` 的 `conversation.view` slot（`kind: 'list', scope: 'session'`），目前由 Chat 使用，组合进来时 `ui-trajectory` 的事件轨迹也用它。把文件预览改到那里——在 Chat 旁新增一个 `File` 标签——不需要新的 UI 体系，只需要一条从另一个包的树形组件点击处到达它的路径。

## 决策

**拆分呈现层，而非复制逻辑。** 文件内容渲染逻辑（加载中／错误／过大／外部打开提示，图片、Markdown、语法高亮文本）从 `ui-workspace` 的 `FileViewer.tsx` 中移出，成为 `ui-primitives` 中一个新的纯组件 `FilePreview`（cordis 无关，不携带宿主或协议层词汇——调用方在渲染前自行把各自的抓取结果归一为纯数据的 `FilePreviewState` 联合类型）。`FileViewer.tsx` 变成 `FilePreview`外面的一层薄 `Modal` 外壳；`ui-conversation` 新增的 `FileView.tsx` 把同一个 `FilePreview` 包成标签页面板，自行解码图片 blob URL，并直接调用具备 `WorkspaceFileBrowseError` 感知能力的 `readFile`（通过 `ui-conversation` 本就依赖的 `runtime` 服务 `ctx.workspaces`——而不是导入 `ui-workspace`，那被跨包规则禁止）。`File` 标签（id 为 `'file'`，order 5，位于 order 0 的 Chat 与 order 10 的 Trajectory 之间）在 `ui-conversation/apply.ts` 中注册，始终存在，首次使用前显示空状态提示——它是标签环的静态条目（见 `docs/cookbook` 的 conversation-view 契约），而非按条件显示。

**跨插件的触发方无法直接写 `chatStore`。** `ui-slots` 在 `SlotRegistry` 私有的 `resolveStore` 内部按 `(entry, scope key)` 解析并缓存某个已声明 store 的绑定 actions 实例；没有公开的 `ctx.slots` 方法能让*另一个*包里 `apply.ts` 层级的代码触达一个存活的实例，而从外部调用 store handle 自身的 `.create(sessionId)` 只会铸造出第二个、彼此不连通的实例，而不是组件实际读取的那个。`ChatStoreState` 新增一个一次性的 `openFilePath` 字段（沿用 `ui-trajectory` 自身跨视图跳转所用的既有 `inspect`／`onInspectDone` 交接模式），`ConvViewOwnerProps` 相应新增 `openFilePath`／`onFileOpened` owner props，但没有任何 `ui-conversation` 之外的代码直接写这两个字段。取而代之的是，`ui-conversation` 拥有一个小型的 `FileOpenRegistryImpl`（`files/file-opener.ts`，一个 `Map<SessionId, SnapshotStore<{path,seq}>>`，形状与既有的 `ComposerBlockRegistry` 完全一致），并通过一个新的可选服务 `ctx.get('conversationFileOpener')` 对外暴露它（`ConversationFileOpener.openFile(sessionId, path): boolean`，采用与 `chatFileMentions` 相同的可选服务约定）。`ConversationSession`——它本身就是 `chatStore` 的注册组件之一，因而合法持有该 store 面向自身会话的绑定 actions——通过一个 `hooks.pendingFileOpen` 舱口订阅该注册表按会话划分的数据源，并在自己的 effect 中把一次待处理请求写入 `setOpenFilePath` 与 `setView('file')`。

`ui-workspace` 的 `FilesNode` 优先调用 `ctx.get('conversationFileOpener')?.openFile(currentSessionId, path)`（通过贯穿 `WorkspaceBrowserInjected`／`WorkspaceBrowser`／`FilesNode` 的新回调 `openInConversation`）；返回 `false`——没有当前会话，或 bundle 中未组合 `ui-conversation`——则回退到既有的 `FileViewer` 弹窗，因此文件树在独立组合时仍能正常工作。

## 备选方案

- **让 `ui-conversation` 直接触达 `ui-workspace` 的 `FileViewer`／`classify.ts`。** 拒绝：`packages/client/AGENTS.md` 禁止在 slot 系统与 `ctx` 服务之外跨包导入另一个插件的符号；`ui-workspace` 只是 `ctx.workspaces` 的一个客户端，并非文件读取概念的所有者，一旦 `FilePreview` 迁移到两个包本就共同依赖的 `ui-primitives` 层，这个方向就完全没有必要了。
- **让 `ui-workspace` 自行注册 `conversation.view` 标签**（仿照 `ui-trajectory` 在自己包内注册的方式）。拒绝：该标签需要读写 `chatStore` 的 `view`／`openFilePath` 字段，这要求在注册时声明 `store: chatStore`，而这是该 store 所属包的专属权限。`ui-workspace` 若不导入 `ui-conversation` 的私有 store 模块就无法持有其绑定 actions，而这正是同一条跨包规则所禁止的。
- **把 `FilePreview` 的渲染逻辑复制成 `ui-conversation` 本地的第二份组件，而不是抽出共享组件。** 拒绝：组成主体渲染的两个重量级基础组件 `ReadBlock`／`MarkdownText` 本就位于两个包都已声明依赖的 `ui-primitives`；真正与宿主相关的部分（`readFile`、`WorkspaceFileBrowseError` 映射、`workspaceId` 解析）留在调用方各自实现，因此抽出纯渲染主体省去了约 90 行重复代码，且不引入耦合成本。
- **让 `apply.ts` 调用 store handle 自身的 `.create(sessionId)` 从组件外部触达绑定 actions。** 追踪 `SlotRegistry.resolveStore` 后拒绝：那个调用点自身的缓存是渲染器私有的，因此第二次调用 `.create()` 只会铸造出一个互不连通的实例，而不是 `ConversationSession`／`ChatView` 实际读取的那个——这是静默地写错，而非仅仅不便。
- **让标签选择对注册表保持响应式，而不写 `chatStore.view`**（渲染时把激活标签解析为 `pendingFileOpen ?? storedView`，完全不调用 `setView`）。拒绝：这会在既有的持久化 `view` 字段之外再新增一个"当前激活标签"的真值来源，偏离 `inspect`／`chat`／`trajectory` 已共用的单字段设计，而一旦注册表消费 effect 已经存在，这样做并不带来任何行为差异。
- **通过导入而非再建一份本地副本来复用 `read` 工具的分类逻辑（`viewerKindFor`／`langFromPath`）。** 出于与 `ui-workspace` 自身那份副本拒绝导入 `dsh-fs-tool-fs` 相同的理由而拒绝：这是一个很小的纯映射，而 `ui-conversation` 导入 `ui-workspace` 的副本将构成与上面被拒绝方案相同的、被禁止的跨包符号导入。

## Consequences

- `ChatStoreState` 新增 `openFilePath: string | null`（与 `inspect` 一样持久化）；`ConversationSessionInjected` 新增 `hooks.pendingFileOpen` 舱口（组件侧对应 `usePendingFileOpen`），仅 `ConversationSession` 消费它。
- `FilePreview`／`FilePreviewState`／`FilePreviewKind` 是 `ui-primitives` 新增的公开导出；从调用方视角看，`FileViewer.tsx` 自身的 `FileViewerProps`／行为未变（依旧是 `Modal`，页脚复制／外部打开等操作不变），因此并列文件浏览器 Agent Note 中对*弹窗*行为的既有描述，对回退路径依旧准确。
- `ConversationFileOpener` 是新增的可选 `ctx` 服务（由 `ui-conversation` 提供，任何包均可 `ctx.get`）；`WorkspaceBrowserInjected` 新增 `openInConversation`，沿 `WorkspaceBrowser`／`SessionTree`／`FilesNode` 与既有的 `listWorkspaceEntries`／`readWorkspaceFile`／`openPath` 一并传递。
- `FileOpenRegistryImpl` 在会话销毁时从不调用 `forget(sessionId)`——这与它所仿照的既有 `ComposerBlockRegistry.forget`（已声明但当前无任何调用方调用）存在相同的缺口；单个会话的 store 会在插件 fiber 卸载前一直保留，性质与它所仿照的既有注册表相同，并无新增。
- `FilePreview`（`ui-primitives`）以及本次改动涉及的每个 `ui-conversation`／`ui-workspace` 新文件，在各自包自身的测试套件中都达到了 100% 的行／分支／函数覆盖率；`ui-workspace/src/client/index.ts` 与 `WorkspaceBrowser.tsx` 仍处于本次改动之前就已存在的 GUI 债务覆盖率豁免名单（`vitest.config.ts`）之内。
