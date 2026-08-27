# Agent Note: 会话 File 标签中的应用内文件编辑

Status: implemented

[English](2026-08-27-file-tab-in-app-editing.md) | 中文

## 问题

会话 File 标签（见[作为会话标签页的文件预览](2026-08-26-file-preview-conversation-tab.zh.md)，之后又新增了 [View／Diff 切换控件](2026-08-27-file-tab-git-diff.zh.md)）此前只能预览文件内容——对工作区文件的任何写入都仍然需要离开应用去使用外部编辑器。浏览器端完全没有任何写入路径：`workspace.readFile`／`gitStatus`／`gitCommitAll`／`gitDiscardAll` 覆盖了读取与 git 操作，但没有任何方式能让客户端覆写文件内容；客户端各包中也没有任何可嵌入的文本编辑面（`ui-primitives` 只有基于 `shiki` 的只读高亮）。

## 决定

**编辑面选用 CodeMirror 6，而不是 Monaco。** Monaco（VS Code 的引擎）长期以来触屏／虚拟键盘支持薄弱，体积达数 MB 且依赖基于 worker 的语言服务——对于一个还需要在低功耗／平板硬件上可用的停靠面板而言，这是较差的选择。CodeMirror 6 是模块化的，只渲染可见的行，并且由若干体积很小、各自独立维护的包组合而成（`@codemirror/state`／`view`／`commands`，外加 `@codemirror/lang-markdown` 用于 Markdown 的列表／引用块续行），而不需要手写一套精简配置。

**编辑时不提供逐语言的语法高亮。** 应用中已经有一套语法高亮实现（`markdown/highlight.ts`，基于 shiki，按语言惰性加载），覆盖了只读的 `ReadBlock`／`FilePreview` View 模式下 `langFromPath` 支持的每一种语言。如果再为编辑面接入第二套、CodeMirror 原生的逐语言语法（grammar），会把这份覆盖——以及它的惰性加载体积成本——重复一遍，却在输入时对读者没有任何可感知的收益。因此 `FileEditor`（`ui-primitives`）是一个不做装饰的等宽字体缓冲区；想看带高亮的代码的用户可以切回 View。Markdown 是唯一的例外：`kind: 'markdown'` 会拆分成两栏，一栏是编辑缓冲区，另一栏是通过既有的 `MarkdownText` 组件、以 150ms 防抖重新渲染的实时预览——这是一个真正的实时预览编辑面，完全用这个包本就已有的组件搭建而成，而不是引入一个新的所见即所得依赖。

**`FileEditor` 在挂载之后是非受控的。** `path`／`text`／`kind` 只在挂载时用于生成初始缓冲区一次；此后文档、撤销历史、光标的归属权都在 CodeMirror 手中，贯穿这个文件的整个生命周期。`FileView` 通过以 `path` 作为 `key` 来重新挂载它，因此切换文件总能得到一个全新的缓冲区，`FileEditor` 也就不需要把外部 prop 的变化协调进一个存活中的 CodeMirror `EditorState`。

**新增 `workspace.writeFile` RPC，采用与它的同级方法完全一样的纯 `node:fs`方式实现，而不是经由 `dsh-fs`。** `workspace.readFile`／`gitStatus`／`gitCommitAll`／`gitDiscardAll` 在 `packages/host/apiproxy` 中都是用纯 `node:fs/promises` 与 `git` 命令行调用实现的（`workspace-files.ts`、`workspace-git.ts`）；`dsh-fs` 的 `FileSystem`／`writeText` 能力只面向模型工具，此前完全没有接入 apiproxy 宿主进程。仅为这一次写入就引入它，会为了没有共享收益而跨越一条既有的包边界，因此 `writeWorkspaceFile` 沿用了它的同级方法既有的先例：它绝不会创建新文件（编辑器只会打开此前一次读取已经解析过的文件），并且它的写入是原子的——先写入同目录下的临时文件，再 `rename`——因此一次失败绝不会在目标路径留下一个不完整的文件。

**写入的过期性防护采用内容哈希，而不是 mtime。** `readWorkspaceFile` 会对它已经读取到的原始字节计算一个 SHA-256 十六进制摘要，并将其作为 `WorkspaceFileContent` 的 `text` 分支上的 `version` 字段返回；`writeWorkspaceFile` 会在实际写入之前，重新读取并重新计算当前磁盘内容的哈希，与调用方提供的 `expectedVersion` 比对，一旦不一致，就以新增的 `file-changed` 业务错误码明确失败，而不是悄悄覆盖一个并发发生的更改（可能来自正在编辑同一文件的 agent、另一个标签页，或外部编辑器）。内容哈希绕开了文件系统 mtime 精度粗糙的问题（有些文件系统的 mtime 精度只到秒级），这种粗糙精度会让基于 mtime 的防护漏掉同一秒内发生的并发写入。哈希比对与原子发布之间存在一个狭窄的"先检查再写入"竞态窗口，这是一个被接受的窄窗口，与 `workspace-git.ts` 自身的写入类操作早已采取并记录的立场一致。

**`FileView` 中新增一个按路径存放的内存草稿缓存，而不是原生的 `beforeunload`／`confirm` 弹窗。** `FileView` 维护一个 `Map<path, { text, version }>`（一个普通的 ref，不是 React state——每次按键只会更新一个响应式的 `hasDraft` 布尔值，而不是重渲染整个标签页），因此切换到另一个文件，或者切到 View／Diff 再切回来，都绝不会悄悄丢失一次编辑；因为根本没有什么会丢失，所以也就不需要弹窗拦截确认。这沿用了输入框自身按会话存放草稿的模式（`inputHub`），而不是另外引入一套未保存更改的拦截机制。保存会清除该路径的草稿；一次因 `file-changed` 而被拒绝的保存会展示一条行内冲突提示，并提供"放弃并重新加载"操作——因为一份过期草稿所基于的版本已不再有效、不能再往上保存，而 v1 也没有提供合并界面。

**范围限定为：仅停靠式 File 标签，仅文本与 Markdown 两种类型。** `ui-workspace` 的模态框 `FileViewer` 回退方案（仅在没有当前会话时使用）没有获得编辑能力——它是一个次要界面，为一个很少触达的路径重复一遍接线工作，没有当前消费方能证成这个投入。二进制与图片文件不提供 Edit 切换控件，与 Diff 切换控件本就划定的范围一致。

## 曾考虑的替代方案

- **Monaco Editor。** 因上述理由被拒绝：对于这个停靠式、需要在平板上可用的面板而言，触屏支持、体积、worker 开销都是比 CodeMirror 6 更差的选择，而且 Monaco 的 Markdown"语言"也只是语法高亮——对于这里真正重要的实时预览功能，它并不比 CodeMirror 多提供任何东西。
- **编辑时提供 CodeMirror 原生的语法高亮**（为 `langFromPath` 的每种语言接入一个 `@codemirror/lang-*`／`@codemirror/legacy-modes` 包，对齐只读 shiki 的覆盖范围）。拒绝：当 View 模式本就能完整、带高亮地渲染同一个文件时，这会把高亮覆盖面及其体积成本翻一倍，换来的只是打字过程中纯装饰性的收益。
- **基于 mtime 的过期性防护**，更字面地对齐 `dsh-fs` 自身 `FsVersion`／基于 `stat` 的用词。拒绝：文件系统的 mtime 精度并非普遍达到亚秒级，因此同一秒内发生的并发写入可能骗过一次基于 mtime 的检查；内容哈希则与底层文件系统无关，总是精确的。
- **把 `dsh-fs` 的 `writeText`／`FsWriteIntent` 接入 apiproxy 宿主进程**，而不是自建一个 `writeWorkspaceFile`。拒绝：这个进程中没有任何其它方法使用那个能力 seam，仅为一次写入就采用它，就意味着要在一个此前从未需要过它的进程里构造一个 `FileSystem` 后端，跨越一条同级的读取／git 方法特意没有跨越的包边界。
- **原生的 `beforeunload`／`window.confirm` 未保存更改拦截。** 拒绝：按路径存放的草稿缓存已经让这种拦截变得没有必要——离开页面从不会丢失任何东西——而原生弹窗的体验也不如直接保留草稿。
- **同时给 `ui-workspace` 的模态框 `FileViewer` 加上编辑能力。** 推迟：目前没有任何消费方需要在活跃会话之外进行编辑，在没有这种需求的情况下在那里重复一遍草稿缓存／保存冲突的接线只会是投机性的。

## 影响

- `ui-primitives` 新增四个依赖（`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`、`@codemirror/lang-markdown`）——每一个都是体积很小、独立维护的 CodeMirror 包，而不是一整块编辑器打包产物。
- `WorkspaceApi`／`IWorkspaces` 都相应扩宽（`writeFile`／`writeWorkspaceFile`），`WorkspaceFileContent` 的 `text` 分支新增了一个必填的 `version` 字段——每一个实现方（`host-apiproxy` 的真实处理器、`client/connection` 的 fixture、`test-support/client-runtime` 的 `TestWorkspaces` 替身，以及 `client/connection`／`client/runtime` 的 `tests/` 中的协议测试替身）都新增了匹配的方法，使这些接口在编译期依旧保持完备。
- `RpcErrorDetailsMap`／`rpcErrorSchema` 新增一个错误码 `file-changed`，与 `file-too-large`／`directory-unreadable` 一起成为 `workspace.writeFile` 可能出现的失败之一。
- File 标签的 Edit 模式仅支持文本／Markdown，且在冲突时不提供合并界面——两者都已记录在 `packages/host/apiproxy/README.md` 与 `packages/client/ui-conversation/README.md` 的 Known Limitations 中。
- `workspace-files.ts` 新增的 `writeWorkspaceFile`／`hashContent`、`workspace.writeFile` 的 RPC 处理器（依据 `packages/CLAUDE.md` 中面向产品可见插件的非单元测试规则，针对一个真实临时目录工作区做了真实组合测试）、`FileEditor`，以及 `FileView` 的编辑模式接线，都新增了包级别的测试覆盖；这个真实组合测试还覆盖了在强制写入失败情形下原子写入"绝不留下不完整文件"的保证。
- 没有新增 `apps/web/tests/snapshots/` 浏览器场景：File 标签页这一区域此前的两个功能（预览标签页、View／Diff 切换控件）都仅凭包级别的组件测试覆盖就发布了，各自都没有自己的 web 快照场景（它们各自的"影响"小节只引用了 `FileView.client.spec.tsx`／`packages/CLAUDE.md` 的覆盖率立场）——本次改动沿用了同样的先例，而不是率先引入第一个这样的场景。一个 File 标签页浏览器场景（打开文件、切到 Edit、输入、保存、校验磁盘写入）仍是一项合理的后续工作，留给这一区域中最先真正需要它的那次改动去补上。
