---
description: "dsh Web 客户端共享的 React UI 原子组件：控件、图标、Markdown 与数学公式渲染，以及终端/读取/差异/搜索/网页输出卡片（零 cordis）。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

[English](README.md) | 中文

## 概述

`dsh-client-ui-primitives` 是 Web 客户端共享的 React 组件库：每个功能插件都用这些原子组件拼装自己的 UI，而这里没有任何内容依赖 Cordis 或 slot 系统。它提供控件集（按钮、胶囊、输入框、菜单、模态框、Toast 横幅、折叠行、悬浮卡片、连接横幅）、图标字形与品牌标记、锚定浮层用的定位钩子，以及 agent 输出的内容渲染器：带 TeX 公式的 markdown、终端输出、文件读取、差异、搜索结果、网页检索与 JSON 检查。这些渲染器为不受信任的模型输出而设计——原始 HTML 会被丢弃、链接会被失效或安全打开、ANSI 转义序列会被解析而非透传。面向用户的文案通过 label prop 提供；拼装某个原子组件的功能插件负责本地化。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只要 Web 客户端需要标准控件或 agent 输出渲染器，就用这些原子组件拼装功能 UI。它们只经 React 渲染，并从主题取得 `--dsw-*` 设计 token，因此无需导入主题或 slot 系统即可适配任意插件。

### 控件与图标

`Button`、`Pill`、`Input`、`Menu`、`Modal`、`Tooltip`、`DisclosureRow`、`StateDot`、`HoverCard`、`Toast`、`ConnectionBanner`、`RiskConfirmation` 与首次运行接管层 `OnboardingSurface` 覆盖常见的交互形态。`ic_ds_*` 图标集与 `FishLogo`/`BrandWordmark` 标记填充品牌与行内图标 slot。`useAnchoredPosition` 与 `useAnchoredMaxHeight` 让浮动面板与底部锚定浮层始终钳制在视口内并跟随锚点。`HoverCard` 通过指针离开宽限期让采用 portal 的预览在跨过锚点间隙时仍可触及，并可通过 `copyText` prop 提供复制按钮。 `Toast` 的停留时长由使用方通过 `holdMs` 指定，因为横幅该留多久取决于有多少内容要读；同一个值同时驱动它的卸载定时器与样式表的淡出延迟，两者不可能再错位。

### 渲染 agent 输出

`MarkdownText` 渲染不可信的 GFM 与 TeX 公式、阻止不安全的链接与图片，并可把已解析的文件提及转换为显式控件。回复流式输出时，它冻结已完成的块，并从保存的 Shiki grammar state 为不断增长的 fence 增量高亮；最终渲染使用相同的 span 树（[增量渲染器](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md)、[流式 fence 高亮](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.zh.md)）。`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock` 与 `WebBlock` 把对应的工具结果意图渲染为带复制控件、溢出处理及适用时 ANSI 处理的卡片。`JsonTree` 与 `JsonBlock` 以只读方式检查 JSON 值；`MessageText` 仍是用户创作内容的字面文本原语。

### 文件预览

`FilePreview` 渲染由调用方归一化后的文件预览主体：Markdown 走 `MarkdownText`，文本／代码走 `ReadBlock`（带行号、shiki 高亮），图片使用调用方提供的 blob URL，其余情况——外部类型（无法识别的扩展名，或调用方从不抓取的类型）、过大、错误，或分类结果期望文本但实际是二进制的读取——都渲染为一行提示。该组件是纯函数式的，不携带任何宿主或协议层词汇：调用方在渲染前，把各自的抓取／分类概念（工作区文件读取、工具 read 结果，或任何其他文件来源）归一为纯数据的 `FilePreviewState`／`FilePreviewKind` 联合类型，因此同一套主体既能组成 `Modal` 包裹的文件对话框，也能组成整版的标签页视图。`imageAlt` 默认取 `path`，`className` 默认取组件自身带滚动上限的外层样式；持有不同外层结构的调用方可分别覆盖。目前有两个消费方：`ui-workspace` 的 `FileViewer`（外面套一层 `Modal`）与 `ui-conversation` 的 `FileView`（外面套一层 `conversation.view` 标签页面板）——见 [File 标签页 Agent Note](../../../.agents/notes/implemented/feature/2026-08-26-file-preview-conversation-tab.zh.md)。

### 文件编辑

`FileEditor` 是 `ui-conversation` File 标签页 Edit 模式背后的应用内文本编辑器：一个 CodeMirror 6 缓冲区（`@codemirror/state`／`view`／`commands`，外加用于 Markdown 列表／引用块续行的 `@codemirror/lang-markdown`），主题完全通过 `ReadBlock`／`SideBySideDiff` 早已在用的同一套 `--dsw-*`／`--dsw-font-markdown-code-block` token 呈现。对于 `kind: 'markdown'`，它会拆分成两栏——编辑面板与一个以 150ms 防抖、通过 `MarkdownText` 重新渲染缓冲区的实时预览面板——为 Markdown 提供一个真正的实时预览编辑面，完全用这个包本就已有的组件搭建而成，而不是引入一个新的所见即所得依赖。对于 `kind: 'text'`，则是一个不做装饰的单栏等宽字体面板。该组件在挂载之后有意保持非受控：`path`／`text`／`kind` 只用于生成一次初始缓冲区，此后文档、撤销历史与光标的归属权都在 CodeMirror 手中，贯穿该文件的整个生命周期；想为不同文件获得全新缓冲区的调用方应以 path 作为 key 重新挂载（`ui-conversation` 的 `FileView` 正是这样做的）。每次编辑都会通过 `onChange` 上报完整缓冲区；`onSaveRequested` 在编辑器获得焦点时绑定 Cmd/Ctrl+S，抑制浏览器自身的"保存页面"对话框。设计取舍说明（选用 CodeMirror 而非 Monaco、编辑时不做逐语言语法高亮、挂载后非受控的约定）：见[应用内文件编辑 Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-file-tab-in-app-editing.zh.md)。

### 本地化文案

这些原子组件无法读取应用 locale，因此每段面向用户的文案都必须通过 label prop 提供。`HoverCard`、`TerminalBlock`、`JsonTree`、`CodeBlock`、`MarkdownText`、`JsonBlock`、`ConnectionBanner`、`Modal`、`DiffBlock`、`ReadBlock`、`SearchBlock` 与 `WebBlock` 接收完整的本地化 label。本包不拥有语言回退；遗漏会导致类型检查失败，各功能会把带类型的 `t` 席位映射到 primitive 的 label 接口。

`SideBySideDiff` 将一个文件的 `HEAD`-与-工作树文本对比渲染为两栏 diff：旧内容在左、新内容在右，各自带独立的行号槽——是 `DiffBlock` 堆叠式聊天卡片的 git 风格对应物，用于 `ui-conversation` 的 File 标签页 diff 视图。它把 `diffLines`（`diff` 包）的输出对齐为行：紧随其后的删除块与新增块（一次替换）会逐行配对，较长一侧多出的行独自占一行、另一栏留空；其余仅删除或仅新增的块，会让另一栏在对应行留空；未改动的行在两栏中保持同步。`oldText`／`newText` 可分别为 `null`（没有 `HEAD` blob，或文件已从工作树中消失），并按空文本处理。与 `DiffBlock`／`ReadBlock` 不同，它展示整个文件、没有高度上限——本身就是专用的整文件视图——也不带语法高亮，与 `DiffBlock` 的选择一致。banner 始终渲染（省略 `path` 时标签为空），并始终携带复制控件，写入统一 diff 风格的 `-`/`+`/空格前缀文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包只做一件事：提供零 cordis、零 slot 知识、仅经 `--dsw-*` token 设置样式的纯 React 原子组件，而所有功能专属的关注点（locale、会话数据、组合）都留在拼装它们的插件中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 原子组件公开导出 |
| [`src/markdown/`](src/markdown/) | Markdown 与数学公式流水线：micromark 解析、KaTeX 排版、增量流式渲染器、`CodeBlock`/`JsonBlock` |
| [`src/TerminalBlock.tsx`](src/TerminalBlock.tsx) | ANSI 转义解析（`anser`）与终端卡片渲染 |
| [`src/ReadBlock.tsx`](src/ReadBlock.tsx) / [`src/DiffBlock.tsx`](src/DiffBlock.tsx) | 读取与差异卡片 |
| [`src/SearchBlock.tsx`](src/SearchBlock.tsx) / [`src/WebBlock.tsx`](src/WebBlock.tsx) | 搜索与网页检索卡片 |
| [`src/icons/`](src/icons/) | `ic_ds_*` 字形组件与品牌标记 |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | 浮动面板与浮层几何钩子 |

### 流式 markdown

回复流式输出期间，`MarkdownText` 增量解析：除末尾两个块外全部冻结为缓存的 React 元素，每个分片只重新解析其后的源文本尾部，因此每分片的工作量跟随尾部而非整个回复。不断增长的 fenced block 会从已保存的 Shiki grammar state 加上尚未完成的最后一行继续分词；已完成行保留其 DOM，定稿渲染则使用相同的 span 树。定稿时的全量解析还会解析跨过冻结边界的引用（[增量渲染器](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md)、[流式 fence 高亮](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.zh.md)）。

### 几何与溢出

输出卡片共享同一套几何模型：`white-space: pre` 并横向滚动，让按列对齐的内容保持对齐；超过 `maxLines`（默认 16）时折叠为头部切片加尾部切片，由展开按钮控制，长正文不会撑高卡片。`TerminalBlock` 把 ANSI 解析为 React span，并带逐行列缓冲处理光标移动，遵循行内擦除、制表位与字符宽度。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明这些原子组件在客户端技术栈与设计系统中的位置。

- [ui-renderer](../ui-renderer/README.zh.md)——挂载组装后应用并绑定 slot 数据的 React 渲染器。
- [ui-tool](../ui-tool/README.zh.md)——拼装这些输出卡片的工具调用展示层。
- [ui-conversation](../ui-conversation/README.zh.md)——渲染 markdown 回复与工具卡片的聊天界面。
- [ui-theme](../ui-theme/README.zh.md)——这些原子组件样式所依赖的 `--dsw-*` token 体系。
- [Web 样式](../../../docs/web-styling.zh.md)——Web 客户端组件的权威样式规则。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明原子组件在边缘情况下的行为；它们是当前包约束，不是组件路线图。

- **流式期间跨边界引用解析被推迟**：定义落在增量冻结边界另一侧的引用式链接或脚注，在回复流式输出期间渲染为字面文本；定稿时的全量解析会将其解析。
- **字形级图标是重新绘制的近似版本**：鱼形标志与闪光标记来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
- **`IconFilePlaceholder16` 不是 figma 抽取素材**：整套图标中其余每一个都是真实设计源导出；这一个是为工作区文件树的文件行准备的纯手绘占位符，等待真正的素材。
- **`Pill` 与 `Input` 没有设计来源**：两个原子组件均自行定义；与其相似的侧边栏搜索字段和视图标签条由消费方组合，不是这些原子组件。
- **`StateDot` 没有 `Active` 变体**：支持的状态为 done、warning、ongoing 和 error。
- **面向用户的文案必须由渲染点提供**：这些原子组件是 zero-Cordis 的，拿不到 `ctx.locale`；各功能必须通过 primitive 的带类型 prop 提供完整本地化 label（见[决策](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。
- **`TerminalBlock` 不是终端模拟器**：它渲染已结束或仍在运行的命令输出，而不是交互式会话：SGR 颜色、回车、退格、行内擦除、制表位与字符宽度会被遵循；绝对光标定位、清屏与备用屏幕序列会被剥离。
- **`FileEditor` 编辑时没有语法高亮**：应用中唯一的语法高亮实现（`markdown/highlight.ts`，基于 shiki）已经为只读的 `ReadBlock`／`FilePreview` View 模式覆盖了 `langFromPath` 支持的每一种语言；再为编辑面接入第二套 CodeMirror 原生的逐语言语法，会把这份覆盖——以及它的体积成本——重复一遍，却对编辑时的读者没有任何收益。这是一个有意划定的范围，不是遗漏。
- **`FileEditor` 的 Markdown 双栏预览没有响应式回退方案**：双栏布局假定停靠面板足够宽，能同时容纳两栏；较窄的宿主环境（例如手机宽度的视口）尚未被处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
