# Agent Note: `dsh --profile headless login` —— `ctx.authorization` 的终端调用方

Status: implemented

[English](2026-08-25-headless-authorization-login.md) | 中文

## 问题

`dsh-authorization`（`ctx.authorization`）以及 `dsh-llm-pi-ai` 为每个已安装的 pi-ai catalog provider 注册的 OAuth flow（`registerPiAiFlows`，以 `llm-pi-ai/<providerId>` 为键）早已存在，但仓库里没有任何地方挂载过这个 seam，也从未在该包自身的测试之外调用过 `begin()`。拥有 Claude Pro/Max（或任何其他 pi-ai OAuth）订阅的人，没有办法把某个 dsh 模型路由授权给它：唯一可行的路径是按量计费的 `ANTHROPIC_API_KEY`，或者把工作转给真正的 Claude Code CLI 作为 subagent（这是另一套机制，服务于另一个目的）。订阅登录的后端已经完整实现，却完全无法触达。

## 决定

**在 base 组合包中挂载 `dsh-authorization`**，紧挨着 `credentials`／`settings`（`packages/bundle/base/cordis.patch.yml`）。它在有调用方调用 `begin()` 之前保持休眠，因此单这一步不改变任何可观察行为——它只是让 `dsh-llm-pi-ai` 已有的作用域内 `ctx.inject(['authorization'], ...)` 得以触发，在每个 profile 中注册它的 flow。

**由 `dsh --profile headless` 充当调用方**，而不是新建一个包或 Web UI surface。它已经是那个一次性、不带 Host／webserver／浏览器的 CLI surface，拥有自己的 commander 解析（`packages/bundle/headless/src/startup.ts`）；pi-ai 的 Anthropic OAuth flow 本身会打开一个本地 HTTP 回调服务器和／或接受手动粘贴的验证码——这是终端原生的形态，而不是浏览器托管的形态。`headless-startup` 的 `[task...]` 根 action 与新增的 `login <key> [--method <id>]` 子命令都发布 `HeadlessStartupValues`，现在它是一个可辨识联合类型（`{mode: 'task', task} | {mode: 'login', key: CredentialKey, method?}`）；`<key>` 在解析阶段就用 `dsh-credentials` 的 `parseCredentialKey` 解析，因此格式错误的键是一次用法错误，而不是运行期错误。

**一个插件、一行 row，按 `config.mode` 分支**（`packages/bundle/headless/src/index.ts`），而不是两行 row、其中一行靠依赖某个兄弟 row 注入服务值的动态 `!!js` 表达式来 disabled——这种模式在本仓库没有先例，其 Loader 求值顺序的保证也未经验证；在一个 `apply()` 内部分支的做法，与 `apps/cli/src/bin.ts` 自己对 `switch (invocation.mode)` 的处理方式是同一种形态。`Config` 的 schemastery 形状是一个扁平对象（`mode` 必填，`task`／`key`／`method` 均为可选），而不是 schema 层面的可辨识联合：本仓库现有的 schemastery 用法里，没有一处校验过由 `z.const` 判别的 `z.object` 分支构成的可辨识联合，而本仓库自己的约定认为 `!!js`／schema 校验这一层是真实的配置边界，理应校验而非假定成立。`apply()` 在 TypeScript 里重新建立判别逻辑，并在内部不变式被违反时抛错——即 `headless-startup`（该配置的唯一写入方)未能将 `mode` 与其对应字段配对，这是本包自身的缺陷，不是用法错误。

**终端版 `AuthorizationInteraction`** 把每次 `notify()` 渲染成 `message` 加上各占一行的 `url`／`code`；每次 `prompt()` 通过从 stdin 读取一行来作答（`node:readline`）；空答案以 `AuthorizationDeclinedError` 拒绝，对应浏览器标签页被关闭的情形。prompt 自带的 `signal`（OAuth flow 在本地服务器与手输验证码的竞速中撤下落败一方时触发）被留给它自己去拒绝，而不是被并入"拒绝"这一分类，这与该 seam 文档中对二者的明确区分一致。`select` 类型的 prompt 渲染为编号列表；返回所选选项的 `id`。

**成功时打印剩下的那一步，而不是沉默。** 提交一条凭据本身并不会让某个适配器的路由生效——`dsh-llm-pi-ai` 在它自己的 `providers.<id>` 设置项存在之前始终保持休眠——因此 `runLogin` 会指出这一步（编辑 `$DSH_HOME/settings.yaml` 或使用 Web 的 Models 页面），而不是把发现它留给人去翻 README。

## 曾考虑的替代方案

- **Web UI 的"登录"流程**（一个设置页面按钮，经由 RPC 网关驱动 `ctx.authorization.begin()`）——按照 `dsh-llm-pi-ai` README 的说法（"提供这些 profile 正是 Web 的 Models 页面所做的事"），这更贴近长期打算的 UX，但它需要新的 gateway RPC surface、客户端 UI，以及在浏览器端处理一套其 OAuth 机制（`127.0.0.1` 上的本地回调服务器）本是为运行 CLI 的那台机器设计、而不必然是运行浏览器标签页的那台机器所设计的 flow。写下本笔记时已推迟；此后已经实现，见 [2026-08-27-web-authorization-signin](2026-08-27-web-authorization-signin.zh.md)。
- **为终端交互新建一个专门的包**——该交互实际上只有一种真实实现（一个真正的终端），当前也没有其他消费方；capability seam 是为一个契约的多个 provider 而设计的，在这里发明一个只会是"有 seam 无需求"。最终把它保留为 `dsh-headless` 内部的一个普通函数。
- **两行组合的 row（`headless-runner` + 一个兄弟 `headless-login`），各自基于对方 mode 做 `disabled: !!js`**——被否决，因为本仓库没有任何现有 row 会基于另一个 row *注入的服务值* 来禁用自身（只有针对静态 `process.platform` 的先例），而在这里把 Loader 的求值／注入顺序搞错会静默失败而不是明确报错。一个插件内部用 TypeScript 分支，不需要这样的假设。
- **为 `Config` 使用 schemastery 的可辨识联合**（`z.union([z.object({mode: z.const('task')...}), z.object({mode: z.const('login')...})])`）——本仓库没有任何示例练习过 schemastery 对由 `z.const` 判别的 `z.object` 分支做联合；在没有先例确认分支能被正确选中的情况下，扁平的可选字段 schema 加上 `apply()` 中显式的 TypeScript 判别，是更诚实、可验证的选择。
- **登录成功后自动写入适配器自己的 `providers.<id>` 设置项**——会让 `dsh login` 变成对一个部署专属选择（启用哪个 provider 路由、以何种形状启用）的静默设置改动，而本仓库的约定把这类选择视为显式配置，不该由一个获取凭据的命令去推断。最终选择打印下一步该做什么。

## 影响

`dsh --profile headless login llm-pi-ai/anthropic` 能端到端地完成一次 Claude Pro/Max 订阅授权，用的正是 `dsh-llm-pi-ai` 早已注册好的 flow；该包内部无需任何改动。同一条命令对任何其他已注册的 flow 都适用（任何已安装 pi-ai catalog provider 的 OAuth 或交互式 api-key 登录，通过它自己的 `llm-pi-ai/<providerId>` 键寻址），也适用于未来任何在同一 seam 上注册的非 pi-ai flow，因为这个 CLI 是围绕通用的 `CredentialKey` 设计的，而不是专为 Anthropic 写死的。

`dsh-authorization` 现在被挂载、因而对每个从 `dsh-base` 派生出的 profile（web、headless、tui，以及任何自定义 profile）都是必需的，不只是 headless——一个从不使用 `login` 的 profile 作者,付出的代价只是多了一行处于休眠状态的插件 row。

登录本身并不会让某个模型可被选中：适配器自己的路由配置仍然是命令会说明、但不会替你完成的另一步。

## 测试

`packages/bundle/headless/tests/headless.spec.ts` 用真实的 Loader 组合、加上一个测试专用的 `AuthorizationFlow`（不会对任何真实 OAuth 签发方发起网络调用）来驱动 `login <key>` 并配上预先写好的 stdin 输入，断言渲染出的 notice、已提交的凭据记录，以及授权成功与被拒绝两条退出路径；原有的 task 模式覆盖保持不变。
