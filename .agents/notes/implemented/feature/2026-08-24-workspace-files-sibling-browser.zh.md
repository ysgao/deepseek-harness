# Agent Note: 与工作区会话列表并列的文件树，含应用内预览

Status: implemented

[English](2026-08-24-workspace-files-sibling-browser.md) | 中文

## 问题

Web GUI 的侧栏会列出某个工作区的会话，但没有办法查看该工作区目录下的文件与子文件夹——想确认工作区实际内容的用户只能离开应用去看。现有的「浏览本地文件系统」原语——`ctx.directoryPicker` 的 `browse` 能力（`host.listDirectory`）——专门用于让用户选择**工作区根目录**，并且有意只列目录（`packages/host/directory-picker-browse` 自身的 dirent 过滤器会跳过一切非目录条目）；原样复用它永远不可能显示文件。扩宽这个 seam 还会把工作区创建选择器的行为，耦合到一个与它无关、暴露面更大的功能上（对工作区下任意文件的常驻可读，而非一次性的根目录选择）。

## 决策

新增一对独立的 `workspace.listEntries`／`workspace.readFile` RPC，直接在 `dsh-api-workspace-controller`（`packages/api/workspace-controller/src/files.ts`）中基于 `node:fs/promises` 实现——不新建能力 seam 包族，`ctx.directoryPicker`／`host.listDirectory` 保持不变。`listEntries` 一次返回一层目录中的目录**与**文件（目录在前，各分组内按名称排序；每个分组各自受 `workspaceFilesMaxEntries`——默认 1000——独立限界）。`readFile` 对合法 UTF-8 返回 `{ kind: 'text', content }`，否则返回 `{ kind: 'binary', mediaType, data: base64 }`，受 `workspaceFilesMaxReadBytes`（默认 20MB，读取前先用 `stat` 探测）限界，超限报 `file-too-large`。两者都接收 `workspaceId`，并在触碰文件系统前校验 `path` 是该工作区自身的规范根路径或其后代（`isWithinWorkspace`，通过 `node:path.relative` 计算，因此共享名称前缀的兄弟目录——`/ws` 与 `/ws-2`——会被正确拒绝），否则回答 `directory-unreadable`。

`ctx.workspaces`（client runtime）在既有的 `listDirectory`／`openPath` 之外新增暴露 `listWorkspaceEntries`／`readWorkspaceFile`。`ui-workspace` 的 `SessionTree` 在每个真实工作区标题行下方渲染新的 `FilesNode` 组件，作为其会话行的第一个同级行（Ungrouped 分组与「单列表」平铺视图没有单一根路径，因此不渲染 Files 节点）。展开后惰性拉取工作区根目录的一层；目录行原地展开自己的嵌套层级（递归的 `FilesLevel`，每次挂载一次 `useLevel` 拉取——没有 `open` 标志，因为调用方只会在真正展开时才挂载该层级）；文件行打开 `FileViewer`，一个按扩展名分派的应用内预览对话框（`packages/client/ui-workspace/src/client/files/classify.ts`）：Markdown 走共享的 `MarkdownText`，可识别的文本／代码扩展名走 `ReadBlock`（带行号、shiki 高亮——语法映射表是 `read` 工具 `langFromPath` 的一份**本地小型复制**，而非导入，因为那个映射位于 `dsh-fs-tool-fs`，一个宿主／模型工具包，导入它会为了一个纯函数跨越 client/host 分层边界），图片通过由 base64 载荷构造的 `URL.createObjectURL` blob 渲染。其余一切——包括 PDF，以及任何分类结果与宿主实际解码结果不一致的读取——都回退到唯一的「用系统默认应用打开」操作，接到既有的 `ctx.workspaces.openPath`（`host.openPath`，未改动）。

## 备选方案

- **扩宽 `host.listDirectory`／`ctx.directoryPicker` 使其上报文件。** 拒绝：这个 seam 存在的全部理由就是选择工作区根目录（按其自身文档化策略只列目录）；对工作区下任意文件的常驻可读，与一次性的根目录选择对话框在暴露面上截然不同，把二者混在一起会让选择器的行为依赖一个与它无关的功能。
- **新建一个仿照 `directoryPicker` 的 `ctx.<service>` 能力 seam（Service Definition + native/browse/auto 后端）。** 拒绝，属于过度构建：文件列举没有与之相对的 OS 选择器可供辨识，因此永远只有一种实现形态；为单一实现建一整个 seam 包族只会增加间接层，且当前没有第二个消费方。
- **让文件列举／读取走 `ctx.fs`。** 拒绝：`ctx.fs` 是面向模型工具的存储 seam（policy 事件、按会话可换的沙箱后端）；骑上去会把 GUI 浏览耦合进模型的限制后端，而且 `ctx.fs` 以 `FsTarget` 为键的 API 并不天然适配任意路径的 GUI 请求。`dsh-api-workspace-controller` 不依赖 `ctx.fs`。
- **从 `dsh-fs-tool-fs` 导入 `langFromPath`。** 拒绝：该包是宿主／模型工具代码；浏览器侧组件导入它会跨越本代码库在别处强制执行的 client/host 分层边界。对一个纯粹、稳定的映射做约 15 行的本地复制是更廉价、更干净的选择。
- **真实的 figma 抽取文件图标。** 推迟：`ui-primitives` 目前尚无此类素材（只有文件夹图标，且都是真实的 figma 抽取），凭空捏造看似合理的 SVG 几何会违背该包的真实素材约定。`IconFilePlaceholder16` 是一个明确的占位符，等待真正的设计素材。
- **应用内 PDF 预览。** 推迟，非拒绝：暂时回退到 `openPath`；需要新的二进制传输路由与 PDF.js 或 `<iframe>` 嵌入，超出本次改动范围。
- **为 `listEntries` 流式构建有序限界窗口（仿照 `directory-picker-browse` 的 `boundedInsert`）。** 对本 seam 拒绝：`boundedInsert` 的 `ListingCandidate` 形状及其单分组假设，无法在不做一次平行重实现的情况下适配目录+文件的双分组切分；`listEntries` 改为按 `readdir` 到达顺序在某分组填满后截断，仍会对已保留的内容排序——未达限界的层级完全有序，而被截断层级则接受一个文档化的、非按名排序的尾部。

## 影响

- wire 新增 `workspace.listEntries`／`workspace.readFile`、一个新的 `file-too-large` 错误码（`path`、`maxBytes` 细节），以及从 `dsh-api-workspace-controller` 自身的 `types.ts` 导出、并直接经其 `client/`（`model.ts`／`service.ts`）贯穿到 `ui-workspace` 的 `FilesNode`／`FileViewer` 的 `WorkspaceEntry`／`WorkspaceEntryListing`／`WorkspaceFileContent` 类型；该包自身的测试 fixture 提供一棵小型确定性文件树（文本、Markdown、一个二进制／图片），覆盖预览矩阵，供无密钥的组装测试使用。
- `WorkspaceController.Config` 新增 `workspaceFilesMaxEntries`／`workspaceFilesMaxReadBytes`（按「不在插件里写死可调参数」规则做成部署可配置），二者均为带所述默认值的自然数。
- 工作区的文件树是只读的：文件或文件夹没有新建／重命名／删除／移动，没有搜索，浏览器重新挂载后也不持久化展开状态（呼应 `ui-directory-picker-browse` 的「无搜索、无持久化」立场）——未来的增量可以在不改动已发布的这两个 RPC 的前提下加上这些能力。
- 文件内容读取在任何字节离开宿主进程之前就已在宿主端限界（`stat` 探测阶段即报 `file-too-large`，先于 `readFile` 执行），因此无法通过这条路径把大文件强灌进浏览器内存。
