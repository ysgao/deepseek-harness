---
description: "dsh Web 客户端的 File 会话视图插件：为一个会话已打开的工作区路径提供应用内预览、编辑与并排 git 差异。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation-files

[English](README.md) | 中文

## 概述

`dsh-client-ui-conversation-files` 是 dsh Web 客户端的 File 会话视图插件：它在 `ui-conversation` 的 `conversation.view` 环中注册 "file" 条目，与 Chat、Trajectory 并列。任何持有工作区路径的插件——Workspace Files 树是第一个调用者——都会把路径交给 `ui-conversation` 的 `conversationFileOpener` 服务，再由本包的标签页渲染：共享的预览主体、在路径存在待处理 git 变更时可选的 View/Diff 切换，以及针对文本与 Markdown 文件的应用内编辑器。与其他每个 `conversation.view` 条目一样，只有安装了本包，该标签页才会被挂载；`ui-conversation` 本身默认不注册任何视图。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用户打开一个工作区路径（来自 Workspace Files 树，或 Chat 消息中的文件引用），它会作为 File 标签页出现在 Chat 旁边。有磁盘 git 变更的文本文件会提供 View/Diff 切换；文本与 Markdown 文件还提供编辑模式，内存中按路径保存草稿，保存时以该文件的读取版本作为守卫，因此并发的磁盘变更会呈现为内联冲突提示，而不是被静默覆盖。二进制、图片与无法识别的文件会回退到用 Host 默认应用打开。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`apply.ts` 会在任意插件首次读取该 slot 时，惰性注册 `conversation.view` 的 "file" 条目；每次 RPC 调用（`readFile`、`gitStatus`、`gitFileDiff`、`writeFile`）都通过 `ctx.get('workspaces')` 解析会话所属的工作区，因此没有所属工作区的会话会明确失败，而不是静默地什么都不做。`FileView.tsx` 拥有标签页自身的 view/edit/diff 模式状态、一个按路径索引的内存草稿缓存，以及惰性的 git 状态/差异获取（只有在真正显示 Diff 切换时才获取）。`classify.ts` 把路径扩展名映射到预览类型与 shiki 语言提示——从 `ui-workspace` 自己的 `classify.ts` 小规模复制而来，而非直接导入，因为这只是一个很小的纯映射，而非共享的业务概念。

本包并不拥有跨插件的文件打开注册表本身：`ui-conversation` 的 `file-opener.ts` 与 `conversationFileOpener` 服务是通用基础设施，无论本包是否被挂载都存在，因此调用方的 `ctx.get('conversationFileOpener')?.openFile(...)` 在本包缺席时会退化为空操作（回退到 Host 默认应用打开），而不是抛出异常。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-conversation](../ui-conversation/README.zh.md) —— 会话外壳、`conversation.view` 环，以及通用的 `conversationFileOpener` 跨插件交接机制。
- [ui-workspace](../ui-workspace/README.zh.md) —— Workspace Files 树，`conversationFileOpener` 的第一个调用者。
- [dsh-api-workspace-controller](../../api/workspace-controller/README.zh.md) —— 本包标签页调用的 Remote 方法（`readFile`、`writeFile`、`gitStatus`、`gitFileDiff`）。
- [ui-primitives](../ui-primitives/README.zh.md) —— 本包组合使用的展示原子组件 `FilePreview`、`FileEditor`、`SideBySideDiff`。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器端的文件展示层，只渲染用户已打开的工作区内容，不会改变模型上下文。

#### KV 缓存影响

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **File 视图文案复用 `ui-conversation` 的语言命名空间**——标签页自身的 `files.*`/`view.file` 键，以及从 Chat 与 Tool 卡片借用的共享键 `copy`/`copied`/`collapse`/`read.*`/`markdown.footnotes`，都存放在该词典中，与 `ui-tool` 对这些共享键已经使用的约定一致。
- **Diff 切换仅支持文本**——二进制与图片文件不在 View/Diff 范围内，与 `FilePreview` 自身对 PDF 预览的处理方式相同；这是延后的后续工作，而非当前功能的缺口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

在引入 `ui-conversation` 的"零默认视图"架构（每个 `conversation.view` 条目，包括 Chat，都是各自独立挂载的包）的上游合并中，从 `ui-conversation` 中提取而来；完整理由见本次合并的 Agent Note。

</details>
