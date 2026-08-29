# Agent Note: 在 RPC 网关上暴露 `ctx.authorization`，用于 Web 端登录入口

Status: implemented

[English](2026-08-27-web-authorization-signin.md) | 中文

## 问题

`dsh --profile headless login <key>`（见 [2026-08-25-headless-authorization-login](2026-08-25-headless-authorization-login.zh.md)）已经让 `ctx.authorization` 可以从 CLI 触达，但 Web 的 Settings 页面——大多数用户在这里管理 provider 凭据——仍然只提供一个只写的 API key 输入框（`packages/client/ui-settings-models/src/client/ProviderEditor.tsx`）。持有 Claude Pro/Max 订阅、又不想敲终端命令的人，没有办法通过他们已经在用的产品 surface 登录。那篇笔记自己的"曾考虑的替代方案"一节点出了这个缺口并将其推迟，理由是缺少网关 RPC surface、缺少客户端 UI，以及该 OAuth flow 的本地回调服务器（`127.0.0.1:53692`，由 `@earendil-works/pi-ai` 的 `loginAnthropic()` 打开）本是为运行 CLI 的那台机器设计的，未必适用于浏览器所在的机器。

## 决定

**`begin()` 是一次长时间挂起的 Remote 调用，而不是"先确认开始、再靠推送补完成"的拆分。** `AuthorizationController`（`packages/api/settings-controller/src/authorization.ts`，生成出的 `ctx.remote.authorization` 命名空间的 Host 端 owner）把 `begin` 声明成一个普通的 `@Remote` 方法，它会 `await` `ctx.authorization.begin()`，直到有人真正点完一个 OAuth 授权页面才返回——以分钟计，而非毫秒——返回值就是结算后的真实 `AuthorizationOutcome`（`authorized`／`cancelled`）。Typert 的 Remote 传输层原生支持这么长时间挂起的调用，因此不需要额外的同步确认步骤；未知的 key／method，或者已经在进行中的尝试，会以抛出的 `AuthorizationError` 的形式出现，由 `failure()` 映射成 `authorization-not-found`／`authorization-in-flight`／`authorization-rejected`。

**Notice 与 prompt 走的是一条专用的流，而不是 `begin` 自己的返回值。** `AuthorizationController.follow` 是一个 `@Remote({ mode: 'stream' })` 方法，背后由 `AuthorizationFeed`／`AuthorizationFollower` 支撑（模式与 `WorkspaceController` 的 `WorkspaceFeed`／`WorkspaceFollower` 重连基线一致）：每次新开一个 `follow()` generation，都会先回放每一个仍处于 pending 状态的 prompt 作为基线，再持续推送实时的 `notice`／`prompt-requested`／`prompt-resolved` 帧，这样无论哪个标签页调用了 `begin`，每个打开的 Settings 标签页都能看到同一次尝试。`respond(key, answer)` 会从任意已连接的标签页应答该 key 上正等待的那个 prompt。`authorization/settled`（该 seam 本就会在每个终态结果发生时发出）不需要额外接线——它直接走 `API_REMOTE_FORWARDED_EVENTS`（`packages/api/remotes/src/{index.ts,types.ts,remote-events.ts}`），紧挨着 `credentials/reference-updated`，即已有的逐字转发白名单。

**状态按 key 收敛，而不是按调用方收敛。** 客户端从不追踪"这次尝试是不是我这次调用发起的"——`AuthorizationRuntime`（`packages/client/ui-settings-models/src/client/authorization-runtime.ts`）把所有推送状态都按 `CredentialKey` 归档，因此即便某次 `begin()` 调用在与另一个标签页的并发调用构成的 TOCTOU 竞态中落败，它依然能正确渲染出真正获胜那次尝试的 notice 与 prompt；落败一方自己那次 `begin()` 调用的 Promise，最终也会以获胜尝试实际产生的结果结算，因为两次调用收敛到的是同一个底层 flow。

**授权的客户端 runtime 没有跨包共享的门面。** 与 Workspace 或 Session 不同，`ui-settings-models` 是 `AuthorizationRuntime` 唯一的消费方，因此状态就近放在这个包内部、紧挨着读取它的 UI，而不是放进单独的 `dsh-api-*-controller/client` 包。`IAuthorization` 只暴露一个普通的 `notifySettled(key)` 方法，而不是自己去订阅事件；`ui-settings-models/src/client/index.ts` 里已有的 pushed-invalidations effect，从它自己的 `ctx.remote.$on('authorization/settled', (key) => { ctx.authorization.notifySettled(key) })` 里调用它——这与该包给 `credentials/reference-updated` 用的桥接方式完全一样。

**`AuthorizationPanel` 是通用组件**，不带任何 Anthropic／OAuth／pi-ai 专属代码：它按形状渲染 `AuthorizationNotice`／`AuthorizationPrompt`（`message`／`url`／`code`；`text`／`secret`／`select`），这正是 `dsh-authorization` 自己模块文档所声明的立场（"渲染一种 flow 的 surface，就能渲染所有 flow"）。`ProviderEditor` 判断是否在某一行显示它的方式，是检查 `ctx.authorization` 已加载的 entry 列表里是否存在与 `${namespace.ns}/${provider}` 相匹配的 `CredentialKey`（针对这个带品牌类型的 key 做字符串比较——`dsh-credentials` 的构造函数放在它承载 service 的 `index.ts` 里，而按照约定 `types.ts` 不含运行期代码，因此没有可供调用的浏览器安全构造函数）——而绝不是判断 `layout === 'pi-ai'` 这一类检查，因此 catalog 没有为其注册任何 flow 的路由（DeepSeek，以及大多数手写声明的 pi-ai 路由）不会多显示任何东西，也不需要维护任何按类别区分的分支逻辑。

**关闭面板不会自动取消。** 在 flow 进行中关闭 Settings 对话框，不会调用 `authorization.cancel()`。按 key 共享的推送状态，正是让这样做安全的原因：一个人在新标签页打开 `auth_url` 链接、然后关掉 Settings 去等待，他的尝试仍会继续进行；重新打开这一行（或者干脆换一个标签页），都能通过 host 流对仍处于 pending 状态的 prompt 的重连回放，拿回同一份实时状态。取消操作，永远只能通过 `AuthorizationPanel` 内部那个显式按钮触发。

**`Omit<AuthorizationPrompt, 'signal'>` 并不是看上去的那样。** TypeScript 内置的 `Omit` 作用在一个联合类型上时，会把它折叠成一个扁平的对象类型，丢掉基于 `kind` 的类型收窄——`prompt.kind === 'select'` 就再也看不到 `options` 了。`packages/api/settings-controller/src/types.ts` 改为通过 `DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never` 导出 `WireAuthorizationPrompt`，并把它贯穿到协议类型、`AuthorizationStreamFrame`，以及 client-runtime 的约定里，取代原本每一处临时写的 `Omit<AuthorizationPrompt, 'signal'>`。

**`dsh-authorization` 的 `authorization/settled` `Events` 声明放在 `types.ts` 里，而不是 `index.ts`。** `dsh-credentials` 自己的 `credentials/reference-updated`／`credentials/record-updated` 正是按这种方式拆分的（`Events` 放 `types.ts`，`Context` 放 `index.ts`），目的就是让浏览器安全的消费方能通过 `import type {} from '.../types'` 拉取事件声明的形状，而不必加载承载 service 的那一半。`authorization/settled` 遵循同样的拆分，以满足 `packages/api/remotes/src/index.ts` 里 `API_REMOTE_FORWARDED_EVENTS` 的类型形状门禁断言。

## 曾考虑的替代方案

- **把原始的 `ctx.remote.authorization` 接口直接穿进 `AuthorizationPanel`**，而不是用更高层的 `IAuthorization` client-runtime service——在 `AuthorizationRuntime` 已经存在之后被否决，因为它已经处理好了 `follow` 流的拉取与按 key 共享的状态；直接用底层的 Remote 接口只会把这两件事都重复实现一遍。
- **让每个 `ProviderEditor` 调用方都必须传 `authorization`**（和 `api` 是必需参数的方式一样）——被否决：`DeepSeekOnboardingDialog` 里只处理凭据的 onboarding 步骤，用不上订阅登录，而且 DeepSeek 本来就没有注册任何 flow。`ProviderEditorProps.authorization` 是可选的；只有真正需要它的调用方 `ModelsSectionInjected.authorization` 才是必需的。
- **`AuthorizationPanel` 卸载时自动取消这次尝试**——直觉上，关闭面板似乎就该停掉一个没人在看的尝试，但支持重连的共享状态设计，恰恰说明这个直觉是错的：一个人在新标签页打开 OAuth 链接、关掉 Settings 去等待，对话框一关，他正在进行的登录就会被立刻杀掉。取消操作永远只能通过那个显式按钮触发。

## 影响

每个挂载了 `dsh-authorization` 的 profile（按前一篇笔记的说法，即所有 `dsh-base` 的派生 profile），只要同时组合了 `@deepseek-ai/dsh-api-settings-controller`，现在也会把它暴露在 RPC 网关上——在有调用方 `begin()` 之前保持休眠，与 CLI 路径的姿态相同。`dsh-authorization` 的包边界也随之调整：往后 `Events` 声明放在 `types.ts` 里，与 `dsh-credentials` 的先例一致，因此未来给这个 seam 添加新事件，应当遵循同样的拆分方式，而不是落在 `index.ts` 里。

浏览器和 harness host 分处两台不同机器时，依然无法自动完成 pi-ai 的 Anthropic OAuth 竞速里回调服务器那一半——`loginAnthropic()` 自己的 `auth_url` notice 已经为此准备了一个"粘贴重定向 URL"的兜底 prompt，`AuthorizationPanel` 把它当作一个普通的 `text` prompt 渲染，不做任何特殊处理。

## 测试

`packages/api/settings-controller/tests/authorization.host.spec.ts` 针对一个真实的 `AuthorizationService` 与一个测试专用、会执行提交的 `AuthorizationFlow`，端到端地覆盖了 `AuthorizationController`，不发起任何真实的 OAuth 网络调用：`list`／`begin` 的拒绝路径（`authorization-not-found`／`authorization-in-flight`／`authorization-rejected`）、`follow` 上 notice／prompt-requested／prompt-resolved／settled 的完整序列、`respond` 的应答与拒绝、`cancel`，以及新开一个 `follow()` generation 时对仍处于 pending 状态的 prompt 的重连回放。原来 `client-handler.spec.ts` 覆盖的那种通用 client-carrier 派发机制（按领域逐个测试），现在是 `dsh-api-gateway` 自己的测试套件，对每个 Remote 命名空间只需覆盖一次，不必按领域重复。

`packages/client/ui-settings-models/src/client/authorization-runtime.ts` 里的 `AuthorizationRuntime`——这个单一的类如今做的事情，就是过去 `AuthorizationManager`／`AuthorizationRuntime` 拆成两个类才做的事情（这个 feature 没有跨包共享的 client-runtime 包可拆）——是通过该包自己的 `apply.client.spec.ts` 以及下面的 panel／editor 测试来间接覆盖的，而不是单独写一份 unit spec，因为它的 `follow` 流拉取与按 key 状态，脱离读取它们的 UI 就没有独立的行为可言。

`packages/client/ui-settings-models/tests/` 有 `authorization-panel.client.spec.tsx`（method 选择、全部三种 prompt 类型、decline／cancel、begin() 与 respondPrompt() 两条失败路径，包括非 `Error` 的 rejection）和 `provider-editor-authorization.client.spec.tsx`（惰性触发的 `refreshEntries()`，以及该入口在匹配／不匹配的行上按数据决定是否显示）。编写 select 类型 prompt 的测试时，发现了一个真实 bug：select 选项的 `onClick` 先调用 `setDraft(option.id)`，紧接着在同一个 tick 里就去读仍然是旧值的 `draft` 闭包变量（React 的状态更新不是同步的），结果发出的是一个空答案，而不是所选选项的 id；修复方式是让 `submitPrompt` 把答案作为显式参数传入，而不是读组件状态。`provider-form.client.spec.tsx`、`components.client.spec.tsx`、`apply.client.spec.ts` 里每一个原有的 `ModelsSection`／`ProviderEditor` 测试 fixture，在 `authorization` 变成必需的 prop／inject 之后，都需要一个 `TestAuthorization` 测试替身（`packages/client/ui-settings-models/tests/test-authorization.client.ts`，形态照搬那个跨包 fixture 包被拆解之前 `TestWorkspaces` 的样子）；默认 `state: 'loaded'` 且没有 entry，这样不相关的测试既看不到登录入口，也不会触发后台 refresh。

逐文件 100% 覆盖率(`pnpm run test:coverage` 这道门禁)在这个 feature 涉及的每一个文件上都成立。`failure()` 对 `AuthorizationError` 分支的处理，记录了(而不是围绕它写测试)一条确实无法触达的路径：`dsh-authorization` 自己的 `begin()` 从不会把一次被拒绝的 prompt 以抛出 `AuthorizationDeclinedError` 的方式交给调用方——它自己观察到拒绝后，就直接把 `begin()` 结算为 `{ status: 'cancelled' }`——因此 `failure()` 只需要映射该 seam 自己抛出的 `NO_FLOW`／`ALREADY_IN_FLIGHT`，加上一个兜底分支。
