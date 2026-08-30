# Agent Note: `bash` rejects an escaping absolute `workdir` before dispatch

Status: implemented

[English](2026-08-30-bash-workdir-escape-preflight.md) | 中文

## 问题

[沙盒 Agent Note](2026-07-06-sandbox.md) 记录了 `workdir` 解析与沙箱约束共享同一个 `SandboxExecutionPolicy`,但 `dsh-tool-bash` 的 `resolveWorkdir` 只把相对路径的 `workdir` 解析为相对会话工作区的路径;绝对路径的 `workdir` 会被原样传给执行器,完全不管已解析出的 `workspaceRoot`。在 `workspace-write`/`read-only` 模式下,一个越界的绝对 `workdir` 仍会到达受限执行器,后者随后以晦涩的运行器失败或沙箱拒绝结果拒绝这次受限的进程启动(或等效的 `cd`)——真正的沙箱约束没有被突破,但模型看到的是一次延迟且令人困惑的失败,而不是明确点出预期工作区根目录的原因。当模型对会话的绝对路径猜错时(沿用了旧的 `pwd` 输出、不同的容器挂载点、抄来的示例路径),此前没有更早、更易理解的信号。

## 决定

`dsh-tool-bash` 新增一个同步的前置检查函数 `rejectWorkdirEscape`,在本次调用的有效 `SandboxExecutionPolicy` 解析完成后(escalation 之后)、`resolveWorkdir`/派发之前运行:当受限执行器已经给出 `workspaceRoot`,且当前有效模式不是 `danger-full-access` 时,一个在词法上越出该根目录的绝对 `workdir` 会抛出 `invalid workdir: "<path>" is outside the session workspace "<root>"; use a relative path instead of an absolute one`。该检查是针对已规范化的 `workspaceRoot` 做词法前缀比较(与 `fs-sandbox` 的 `isPathUnder` 在常规拼写下所走的同一条低成本快速路径)——不做 `stat`,不做符号链接遍历:执行器自身的操作系统级约束(Landlock/bwrap/Seatbelt)始终才是真正的安全边界,这次前置检查不需要该边界所拥有的异步祖先身份兜底逻辑。

已经位于 `workspaceRoot` 内部的绝对 `workdir`、`danger-full-access` 下的任意 `workdir`,以及没有挂载受限执行器时的任意 `workdir`(`dsh-bash-local`,绝大多数测试场景)均不受影响——"显式绝对 `workdir` 会覆盖会话 cwd" 这一既有约定在所有没有工作区根目录可供违反的场景下继续成立。`workdir` 参数的描述新增一句话说明该限制,让模型在决策时就学到这条规则,而不是只能从被拒绝的调用中获知。

## 权衡的替代方案

**无条件拒绝任何绝对 `workdir`(只允许相对路径)。** 已否决:这会破坏已有文档记录且已测试的约定——绝对 `workdir` 会覆盖会话 cwd(`tools/tools.spec.ts` 中的 `'an explicit absolute workdir overrides the session cwd'`),而且已经位于工作区内部的绝对路径本就不是需要拒绝的错误。

**采用 `fs-sandbox` 的 `isPathUnder` 完整异步包含检查(祖先文件系统身份遍历)。** 已否决:该兜底逻辑的存在是为了在针对一次真实变更强制执行的包含边界下,识别别名等价的根目录(Windows 8.3/长文件名、大小写)。而这里的边界仍然是执行器自身的约束;这次前置检查只是把一次延迟且晦涩的拒绝提前变得清晰,因此同步的词法快速路径对每次调用而言都是合适的成本,包括完全跳过该检查的非受限组合。

**在 shell 服务定义(`dsh-shell`)而非工具层实现约束。** 已否决:服务定义有意保持无会话状态([capability-seam 理由](../architecture/2026-06-13-capability-seams.zh.md));`workspaceRoot` 只在 `ctx.sandboxPolicy.resolve()` 之后按次调用存在,而工具层本就已经为 escalation 与 `workdir` 解析拥有这一结果。

## 后果

一个受限会话若收到过期或错误的绝对 `workdir`,现在会在任何进程启动之前就同步失败,并在错误信息中点出预期的工作区根目录,而不是通过执行器的运行器失败或拒绝通道才暴露出来。非受限组合与工作区内部的绝对路径不受影响;既有的 `workdir` 测试矩阵(`tools.spec.ts`)新增了四个用例,分别覆盖受限-越界拒绝、受限-内部接受、escalation 后越界接受,以及非受限直通。
