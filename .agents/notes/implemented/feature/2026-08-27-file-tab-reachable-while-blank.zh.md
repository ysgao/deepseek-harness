# Agent Note: 让 File 标签页在会话首轮之前就可用

Status: implemented

[English](2026-08-27-file-tab-reachable-while-blank.md) | 中文

## 问题

`ConversationSession` 会对任何尚未发送第一条消息的会话隐藏整个视图环——Chat、File、Trajectory 一概如此（`blank && composerPhase === 'blank'` → 渲染 `null`；同级的 header 也用同样的条件隐藏其标题／标签栏），取而代之的是一个全屏接管的 Hero 欢迎界面（`ConversationRoot.tsx`）。这个逻辑早于 File 标签页存在：它是在唯一的视图只有 Chat 时写的，对于 Chat 而言，用欢迎界面取代一个空的对话记录是合理的。File 标签页自身的设计笔记曾宣称它"始终存在……不会被条件性隐藏"，但这个说法从未针对空白会话的情形做过验证——在会话仍是空白状态时点击 Files 树中的一个文件，确实会按设计把活跃视图设为 `'file'` 并打开对应路径，但整个视图区域依旧被隐藏在 Hero 后面，因此什么都不会显示。浏览或编辑一个工作区文件并不需要先跑过一轮对话，所以这是一个真正的缺口，而不是有意为之的范围界定。

## 决定

**只放行 File 标签页，且判据是持久化的当前激活视图 id，而不是一次性的 `openFilePath` 交接信号。** 两处判据（`ConversationSession` 的提前返回，以及 `ConversationSessionHeader` 的 `hideChrome`）现在都在既有的 blank／composerPhase 检查之外，同时判断 `active?.id !== 'file'`。`active.id` 来自 store 中持久化的 `view` 字段（由既有的文件打开消费副作用调用一次 `setView('file')` 设置，此后不会在别处被重置）——而不是 `openFilePath`：后者是一个一次性信号，`FileView` 一旦确认收到交接就会立刻把它清空，如果用它作判据，标签页会先一闪而现，然后立刻又被重新隐藏。Chat 和 Trajectory 保留既有的"仅在 Hero 中"行为：一个空白会话确实没有对话记录、也没有工具调用可看，因此把它们隐藏在 Hero 之后在那两个标签页上依然是正确的。

Hero 版的 composer 与已可见的 File 标签页共存，而不是被它取代：`ConversationRoot` 自身的 `hero` 计算逻辑未做任何改动，因此欢迎卡片、Workspace 选择器与输入框依旧渲染在（此刻已可见的）视图区域下方——用户可以一边浏览或编辑文件，一边仍然看到同样的"开始对话"引导。

## 曾考虑的替代方案

- **只要活跃标签不是 Chat 就显示整个视图环**（连 Trajectory 一并放行）。按明确的产品方向拒绝：对于一个尚无工具调用的会话，Trajectory 没有任何内容可显示，继续把它隐藏在 Hero 之后可以避免出现一个没有真实内容的空标签页；这与 File 不同——File 始终有一个真实的工作区路径可以渲染。
- **直接以一次性字段 `openFilePath` 作为判据。** 拒绝：它会在 `FileView` 自身的副作用确认收到交接的那一刻立即清空为 `null`（这是它"一次性、允许重新打开同一路径"的设计），因此标签页会先打开，紧接着在下一次渲染就又被隐藏。
- **在首次打开文件时把会话提升出"空白"状态。** 拒绝：blank／composerPhase 是关于"是否已经跑过一轮"的、由服务端权威决定的事实；打开一个文件只是纯客户端、不涉及任何一轮对话的交互，绝不能伪造出一轮对话发生过的假象。

## 影响

- `ConversationSessionHeader`／`ConversationSession`（`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`）都新增了 `active?.id !== 'file'` 这一判据；没有改动其它任何视图或组件。
- `tests/skeleton.client.spec.tsx` 新增了一个用例，断言在空白会话上一旦触发 `setView('file')`，File 标签页就会渲染（header 可见、标签列表包含它、`File` 标签被选中、内容存在）；而原有的"hero 阶段"测试（Chat 处于激活状态、会话空白）不受影响——完整测试套件仍然全部通过，验证了这一点。
- 已在一个真实运行的实例上完成端到端验证：一个尚未发送任何消息的全新会话，可以从 Files 树中打开一个文件、查看并编辑它，同时 Hero 欢迎界面／composer 依旧显示在下方。
