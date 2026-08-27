# Agent Note: File 标签分栏面板的可拖拽调整分隔线

Status: implemented

[English](2026-08-27-file-tab-resizable-panes.md) | 中文

## 问题

File 标签的两个分栏呈现面——`FileEditor` 的 Markdown 编辑/预览分栏（见[应用内文件编辑](2026-08-27-file-tab-in-app-editing.zh.md)）与 `SideBySideDiff` 的新旧 diff 两栏（见[并排 git diff](2026-08-27-file-tab-git-diff.zh.md)）——都把容器分成两条固定的等宽轨道（分别是 `grid-template-columns: 1fr 1fr` 与两条 `1fr` 内容轨道），完全没有办法改变分栏比例。想给某一侧多留些空间的读者（比如一段较长的 Markdown 源码旁边挤着一个窄预览栏，或者 diff 里某一侧的行特别长），完全没有办法做到。

## 决定

**新增一个共享 hook，`ui-primitives` 中的 `useSplitRatio`**，把分隔线的位置追踪为左侧／旧侧面板占容器宽度的比例，按 `[min, max]` 夹紧（默认 `[0.2, 0.8]`，`defaultRatio` 为 `0.5`）。它导出 `dividerProps`——带指针捕获的 `onPointerDown`／`onPointerMove`／`onPointerUp`／`onPointerCancel`，重置为 `defaultRatio` 的 `onDoubleClick`，以及在左右方向键上按固定步长微调的 `onKeyDown`——供调用方直接铺到自己的分隔线元素上。这套模式（指针捕获拖拽、用 ref 保存拖拽起点快照、clamp 夹紧函数、双击重置、方向键步进）与 `AppFrame`（`ui-layout`）和 `TrajectoryTable`（`ui-trajectory`）中既有的私有拖拽手柄如出一辙；这是代码库中第三次出现该模式，而这一次的两个调用方恰好都住在同一个包里，这才让把它提炼出来比再复制一份第四份实现更合理。`onPointerDown` 读取分隔线自身 `parentElement` 的 `getBoundingClientRect().width` 作为容器宽度，因此调用方唯一的放置要求就是让分隔线渲染为它所划分的那个元素的直接子节点。

**两个调用方都用针对 CSS 自定义属性的 `calc()` 来确定列宽，而不是 JS 计算出的内联宽度。** `FileEditor.module.css` 的 `.splitRoot` 变成一个 3 轨网格（`calc((100% - 8px) * ratio) 8px calc((100% - 8px) * (1 - ratio))`），中间那条轨道容纳一个真实的分隔线元素（通过 `::after` 画出的一条细线，而不是原来那种共享背景色的网格间隙技巧）。`SideBySideDiff.module.css` 的 `.body` 变成一个 5 轨网格（`gutter, calc(...*ratio), 8px, gutter, calc(...*(1-ratio))`）——新增的 8px 轨道插在两条内容列之间，而 `.row` 的四个单元格（仍然是 `display: contents`）需要显式指定 `grid-column`（1、2、4、5），因为 CSS Grid 的自动布局本身无法跳过一条被预留占用的列。分隔线本身以 `grid-row: 1 / -1` 的形式作为一个普通网格项（不是 `display: contents`）放置在这条预留列里，因此它只渲染一次，并随 `.body` 的水平滚动一起滚动，而不需要单独追踪滚动位置。

## 曾考虑的替代方案

- **把 `TrajectoryTable` 现有的私有拖拽手柄提炼成共享组件，而不是新写一个 hook。** 拒绝：那份实现带有一个针对其自身三栏布局定制的成对列让步求解器（`clampDetailsWidth`／`defaultToolRequestWidth`），并且位于 `ui-trajectory` 包中——这两个 File 标签调用方都不依赖该包；为了这个更简单的两栏场景把它引进来，等于新增了一条本不需要的跨包依赖。
- **在组件状态里保存一个像素宽度**，随容器尺寸变化通过 `ResizeObserver` 重新测量。拒绝：一个基于 `calc()`、相对 `100%` 的比例在容器尺寸变化（面板宽度变化、窗口缩放）时无需任何 observer 就能保持正确；换成像素宽度的话，每次尺寸变化都得重新推导一遍，否则比例就会跑偏。
- **让比例跨重新挂载持久化**（会话状态、`localStorage`）。推迟：`FileEditor` 本就按设计在每次打开文件时重新挂载（见[应用内编辑 Agent Note](2026-08-27-file-tab-in-app-editing.zh.md)），因此比例在每次打开文件时重置，这与该组件"挂载后即不受控"的既有姿态是一致的；目前没有任何调用方要求跨文件或跨会话的持久化。

## 影响

- `ui-primitives` 新增一个导出 `useSplitRatio`（连同它的 `SplitRatioOptions`／`SplitRatioResult`／`SplitDividerProps` 类型），不新增任何依赖。
- `FileEditor.module.css` 与 `SideBySideDiff.module.css` 都从静态的等比例网格改为由每个组件各自的 CSS 自定义属性（`--ds-file-editor-ratio`、`--dsl-sbs-diff-ratio`）驱动的 `calc()` 轨道；`SideBySideDiff` 的行单元格因为分隔线要占用自己的轨道，新增了此前并不需要的显式 `grid-column` 定位。
- `useSplitRatio.ts`、`FileEditor.tsx` 与 `SideBySideDiff.tsx` 在 `ui-primitives` 自身的包测试套件中都达到 100% 的行／分支／函数覆盖率（`useSplitRatio` 指针按下处理函数中的一处 `container === null` 防护被标记为 `v8 ignore`：每个调用方都把分隔线渲染为它所划分容器的直接子节点，因此任何可移植测试都无法让一个已挂载的分隔线变得没有父节点）；新增的 `use-split-ratio.client.spec.tsx` 通过一个最小化的宿主组件直接测试该 hook，两个既有组件的测试文件也都新增了拖拽分隔线的断言。
- 没有新增 `apps/web/tests/snapshots/` 浏览器场景，延续了此前两篇 File 标签 Agent Note 已经为这块区域确立的先例：对这个呈现面而言，包级组件覆盖率、而不是浏览器转录，一直是既定的达标线。
