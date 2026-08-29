# Agent Note: 工作区文件树新增"新建文件/新建文件夹"操作

状态：已实现

[English](2026-08-29-workspace-files-add-file-folder.md) | 中文

## 问题

工作区文件树（[同级浏览器](2026-08-24-workspace-files-sibling-browser.zh.md)、[git 状态](2026-08-27-workspace-files-git-status.zh.md) 两篇 Agent Note）可以浏览、预览、编辑、比较已有文件，但没有创建新文件的方式：想新增文件或文件夹的用户必须离开应用，使用系统文件管理器或终端操作，再用文件树自身的刷新操作才能看到结果。`workspace.listEntries`/`workspace.readFile`/`workspace.writeFile` 已经确立了"仅文件树使用的主机原语，不经过沙箱，直接调用 `node:fs/promises`"这一模式（`files.ts`）；文件/文件夹创建需要同样形态的新增，且与 `writeFile`（只会覆盖已有文件）明确区分。

## 决策

**两个新的 `@Remote` 方法，`workspace.createFile`/`workspace.createDirectory`，构建在 `listEntries`/`readFile`/`writeFile` 的模板之上。** 两者都接收 `WorkspaceCreateEntryRequest { workspaceId, parentPath, name }`——父目录加单一名称片段，而非调用方拼接好的路径，这样请求就无法通过在 `name` 中夹带路径分隔符来逃逸出 `parentPath`。`file-commands.ts` 新增的 `requireContainedChildPath` 先校验 `name`（非空、非 `.`/`..`、不含 `/`\`），再通过既有的 `requireContainedPath` 工作区根目录包含性检查解析 `parentPath`，最后拼接二者——与 `directory-picker.ts` 现有的 `createDirectory(path, name)` 校验自身名称片段的顺序一致，这里是复用其先例而非共享代码（两个能力接口保持独立：本方法限定于工作区根目录内且专用于文件树，那个方法是选择器自身的目录专属浏览）。

**`files.ts` 新增 `createWorkspaceFile`/`createWorkspaceDirectory`，两个主机原语都在目标已存在时直接失败，而不是静默成功或覆盖。** `createWorkspaceFile` 调用 `node:fs/promises.writeFile` 并传入 `flag: 'wx'`（独占创建——目标路径已存在时以 `EEXIST` 拒绝，因此绝不会截断真实内容，这与 `writeFile` 刻意设计的版本保护式覆盖不同）。`createWorkspaceDirectory` 调用 `mkdir` 并传入 `recursive: false`——只创建一个新的路径片段，绝不会静默创建一连串缺失的父目录。`WorkspaceFileError` 新增两个供二者共用的错误码：`already-exists`（对应 node:fs 的 `EEXIST`）与 `parent-missing`（`ENOENT`——外层目录不存在）；`types.ts` 的 `WorkspaceErrorDetailsMap` 新增对应条目，外加请求层名称片段校验专用的 `invalid-name`。

**客户端与 UI 的接线方式完全照搬 `writeFile` 的同级 props。** `IWorkspaces` 新增 `createFile`/`createDirectory`（workspaceId、parentPath、name、signal → 创建出的路径）；`ClientWorkspaceModel`/`WorkspaceController`（客户端服务面）各自实现一层薄透传，复用既有的 `WorkspaceFileBrowseError` 包装（而非新建错误类），因为这些失败与 `readFile`/`writeFile` 的拒绝一样，都通过 `error.name` 判别。`WorkspaceBrowserInjected`/`WorkspaceBrowser`/`SessionTree`/`FilesNodeProps` 各自在既有文件相关 props 旁新增 `createWorkspaceFile`/`createWorkspaceFolder`。

**两个新图标 `IconNewFile16`/`IconNewFolder16`**，作为第五、第六个加入既有四个 `(手绘、描边风格、无 figma 来源)` 图标之列（`ic_ds_arrow_up_outline_14` 及其三个同类）：每个都是在既有的文件占位符/文件夹关闭轮廓基础上缩小并向左上方偏移，并在右下角叠加一个小的实心圆加号徽标（12% 不透明度的 `currentColor` 圆形 + 一个加号描边）——正是需求中"默认图标在角落加一个小加号"的确切组合，绘制为一个扁平的 SVG，而非运行时叠加（与该图标集中每个图标都是自包含组件的做法保持一致）。

**新建文件/新建文件夹按钮位于文件树标题栏，始终可见——不同于 git 操作组（`GitStatusSummary`），后者在非 git 工作树中不渲染任何内容。** 新增的 `AddEntryButtons` 组件无条件渲染在 git 分支/状态显示之前；点击任一按钮会打开 `CreateEntryInput`，一个原地替换标题栏尾部操作组的内联名称输入框（与提交操作中 `GitCommitInput` 已有的替换方式相同）——回车提交，Esc 取消，一对勾选/关闭图标提供相同的两个点击操作。

**目录行自身的点击同时完成展开/折叠与标记创建目标，而非新增一个独立的选中手势**：`FilesNode` 追踪 `selectedDirPath: string | null`（null 表示工作区根目录），与既有的 `gitStatusFiles` prop 一起向下传递至 `FilesLevel`/`DirectoryRow`；最近一次点击的目录会获得一个持续存在的 `.rowSelected` 高亮（区别于 `:hover`，使用主题的 `--dsw-alias-interactive-bg-active` 令牌），即使指针移开也依然保留，且即便该行随后被再次折叠，仍然保持为创建目标。折叠或重新展开文件树节点本身（根标题行自己的开关）总会把目标重置回工作区根目录——先前展开时选中的某个子目录残留状态绝不能悄悄地在树实例之外继续存活。提交新建文件/新建文件夹会以 `selectedDirPath ?? rootPath` 调用 `createWorkspaceFile`/`createWorkspaceFolder`，成功后沿用既有的 `levelRefreshKey`（与 `commitAllChanges`/`discardAllChanges`/`pullRebase` 已经使用的"写操作改变了树，重新挂载当前展开的层级"机制相同），使新条目在其父目录展开（或变为展开）后即可显现。

**同一时刻只允许一个写操作运行**，在既有的 `busy` 门控（`discardPending || discardConfirming || pullPending || pushPending`）基础上加入 `createPending`——创建文件/文件夹同样会触及 git 操作所修改的工作树，因此二者共用同一套单写入者纪律。创建失败（`already-exists`、`parent-missing`、`invalid-name`，或通用 I/O 错误）会显示内联提示并保持输入框打开，而不是关闭它，这样在修复根本原因（或调用方在别处重命名了冲突文件）后重试同一名称无需重新打开新建流程。

## 考虑过的替代方案

- **用单个 `createEntry({ workspaceId, parentPath, name, kind })` RPC 方法取代两个方法。** 已拒绝：`listEntries`/`readFile`/`writeFile` 在此 Controller 上已经是一个动词对应一个操作，而文件与目录的创建使用不同的主机原语（`writeFile` 配 `wx` 对比 `mkdir`）以及不同的响应结构（`WorkspaceCreateFileValue` 携带内容版本，`WorkspaceCreateDirectoryValue` 不携带）——共用一个动词需要一个带判别标记的请求/响应对，却不能减少接口面积。
- **递归创建目录（`mkdir` 配 `recursive: true`），静默创建缺失的中间父目录。** 已拒绝：产品需求是在一个明确的、已经可见的位置（工作区根目录或用户刚点击的目录）"新建一个文件/文件夹"，而不是"创建任意的嵌套路径"——在用户从未要求、且直到树刷新前都看不到的情况下静默制造中间目录，会是一个令人意外的副作用。改由 `parent-missing` 以拒绝的形式呈现同样的状况。
- **为"选中此文件夹作为目标"新增一个独立的 `<button>`/右键菜单入口，与该行自身的展开/折叠点击相互独立。** 根据直接的产品反馈已拒绝：两个手势共用同一次点击，这样文件夹无需保持展开状态即可继续作为创建目标，也无需为第二个交互界面单独设计、加样式、写测试。
- **将新建文件/新建文件夹控件放在标签栏（Chat/File/Trajectory）中，仅在文件标签激活时可见。** 已拒绝，改为放在文件树自身的标题栏——创建操作的自然归属是与既有的 git 操作并排在同一行，而不是让用户再学习一个新位置。
- **覆盖已存在的目标，而不是以 `already-exists` 失败。** 已拒绝：`writeFile` 已经通过 `expectedVersion` 拥有"受保护的覆盖"行为；一个裸的"创建"操作在名称冲突时静默覆盖已有内容，且没有任何确认步骤，会造成数据丢失的意外。

## 影响

用户现在可以直接在工作区根目录下，或在他们点击过的任意目录下（无论是否展开）创建一个新的空文件或文件夹，而无需离开应用；新条目会在其父目录展开后出现在树中，方式与提交或放弃操作已经呈现变更工作树的方式相同。即使工作区完全没有 git 仓库，新建文件/新建文件夹按钮依然可用，这与标题栏中其他所有操作不同。创建文件不会自动打开它——用户仍需点击新行来预览或编辑，这与今天发现一个刚提交或刚拉取的文件的方式一致。`already-exists`/`parent-missing`/`invalid-name` 是对共享的 `WorkspaceErrorDetailsMap` 封闭错误码表的新增，因此对每一个穷举该错误码的既有消费者都是可见的；在此变更之前没有任何消费者这样做过（已核实：`FileView.tsx`、`FileViewer.tsx`、`FilesNode.tsx` 都只窄化处理它们各自专门处理的错误码，其余情况一律走通用兜底分支）。
