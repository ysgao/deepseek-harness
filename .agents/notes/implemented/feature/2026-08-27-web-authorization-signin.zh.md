# Agent Note: 在 RPC 网关上暴露 `ctx.authorization`，用于 Web 端登录入口

Status: implemented

[English](2026-08-27-web-authorization-signin.md) | 中文

## 问题

`dsh --profile headless login <key>`（见 [2026-08-25-headless-authorization-login](2026-08-25-headless-authorization-login.zh.md)）已经让 `ctx.authorization` 可以从 CLI 触达，但 Web 的 Settings 页面——大多数用户在这里管理 provider 凭据——仍然只提供一个只写的 API key 输入框（`packages/client/ui-settings-models/src/client/ProviderEditor.tsx`）。持有 Claude Pro/Max 订阅、又不想敲终端命令的人，没有办法通过他们已经在用的产品 surface 登录。那篇笔记自己的"曾考虑的替代方案"一节点出了这个缺口并将其推迟，理由是缺少网关 RPC surface、缺少客户端 UI，以及该 OAuth flow 的本地回调服务器（`127.0.0.1:53692`，由 `@earendil-works/pi-ai` 的 `loginAnthropic()` 打开）本是为运行 CLI 的那台机器设计的，未必适用于浏览器所在的机器。

## 决定

**`begin()` 确认的是"已经开始"，而不是"已经完成"**，与 `session.prompt` 的 `{accepted: true}` 形态相同。`ctx.authorization.begin()` 要等到有人真正点完一个 OAuth 授权页面才会返回——以分钟计，而非毫秒——因此 `POST /api/authorization.begin`（`packages/host/apiproxy/src/api-proxy.ts`）先通过 `ctx.authorization.describe(key)` 做同步校验（未知的 key／method，或已经在进行中的尝试，会立即以 `authorization-not-found`／`authorization-in-flight` 拒绝），然后调用 `ctx.authorization.begin()` 但不等待其完成，直接返回。这次尝试产生的每一条 notice、prompt 与结算（settlement），都靠推送状态送达，而不是这次响应本身。

**Notice 与 prompt 走的是 host 流，而不是 mux 流。** 授权没有归属会话，因此它的帧（`authorization/notice`、`authorization/prompt-requested`、`authorization/prompt-resolved`）属于 `HostFrame`，而不是 `MuxFrame`。prompt-requested／resolved 这一对的应答方式，与 `approval/requested`／`question/requested` 完全一致：一个稳定的 `rpcId`、一个 `pendingAuthorizationPrompts` map，以及新增的 `hostQueues` 广播集合（`host()` 此前没有与 `mux()` 的 `muxQueues`／`broadcast()` 对等的共享广播机制——此处补上），这样每个打开的 Settings 标签页都能看到同一次尝试。`respond()` 新增了第三条路由分支，与 approval、question 并列。`authorization/settled`（该 seam 本就会在每个终态结果发生时发出）不需要新的帧类型——它被直接加入 `API_REMOTE_FORWARDED_EVENTS`，紧挨着 `credentials/reference-updated`，即已有的逐字转发白名单。

**状态按 key 收敛，而不是按调用方收敛。** 客户端从不追踪"这次尝试是不是我这次调用发起的"——`AuthorizationRuntime`（`packages/client/runtime/src/client/authorization/`）把所有推送状态都按 `CredentialKey` 归档，因此即便某次 `begin()` 调用在与另一个标签页的并发调用构成的 TOCTOU 竞态中落败，它依然能正确渲染出真正获胜那次尝试的 notice 与 prompt；败者收到的 `{accepted: true}` 确认，从来就只是在"启动流程"这件事上撒了个谎，从未影响 UI 实际显示的内容。

**`dsh-client-runtime` 从不调用 `ctx.remote.$on`。** `packages/client/runtime/src/` 内部没有任何代码订阅 Remote 事件；只有基于该 runtime 构建的 feature 包才会这么做（`ui-settings-models` 已经用这种方式桥接了 `credentials/reference-updated`，而 `wire-events.client.spec.ts` 里伪造的 `remote` service 刻意只实现了 `$dispatch`，注释写明"这个 spec 负责的是 carrier 的交接，不是它背后的扇出"）。`authorization/settled` 的观察方式遵循同一种分层：`IAuthorization` 只暴露一个普通的 `notifySettled(key)` 方法，而不是自己去订阅；`ui-settings-models/src/client/index.ts` 里已有的 pushed-invalidations effect，从它自己的 `ctx.remote.$on('authorization/settled', ...)` 里调用它。

**`AuthorizationPanel` 是通用组件**，不带任何 Anthropic／OAuth／pi-ai 专属代码：它按形状渲染 `AuthorizationNotice`／`AuthorizationPrompt`（`message`／`url`／`code`；`text`／`secret`／`select`），这正是 `dsh-authorization` 自己模块文档所声明的立场（"渲染一种 flow 的 surface，就能渲染所有 flow"）。`ProviderEditor` 判断是否在某一行显示它的方式，是检查 `ctx.authorization` 已加载的 entry 列表里是否存在与 `${namespace.ns}/${provider}` 相匹配的 `CredentialKey`（针对这个带品牌类型的 key 做字符串比较——`dsh-credentials` 的构造函数放在它承载 service 的 `index.ts` 里，而按照约定 `types.ts` 不含运行期代码，因此没有可供调用的浏览器安全构造函数）——而绝不是判断 `layout === 'pi-ai'` 这一类检查，因此 catalog 没有为其注册任何 flow 的路由（DeepSeek，以及大多数手写声明的 pi-ai 路由）不会多显示任何东西，也不需要维护任何按类别区分的分支逻辑。

**关闭面板不会自动取消。** 在 flow 进行中关闭 Settings 对话框，不会调用 `authorization.cancel()`。按 key 共享的推送状态，正是让这样做安全的原因：一个人在新标签页打开 `auth_url` 链接、然后关掉 Settings 去等待，他的尝试仍会继续进行；重新打开这一行（或者干脆换一个标签页），都能通过 host 流对仍处于 pending 状态的 prompt 的重连回放，拿回同一份实时状态。取消操作，永远只能通过 `AuthorizationPanel` 内部那个显式按钮触发。

**`Omit<AuthorizationPrompt, 'signal'>` 并不是看上去的那样。** TypeScript 内置的 `Omit` 作用在一个联合类型上时，会把它折叠成一个扁平的对象类型，丢掉基于 `kind` 的类型收窄——`prompt.kind === 'select'` 就再也看不到 `options` 了。`packages/host/apiproxy/src/api/authorization.ts` 改为通过 `DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never` 导出 `WireAuthorizationPrompt`，并把它贯穿到协议类型、`HostFrame`，以及 client-runtime 的约定里，取代原本每一处临时写的 `Omit<AuthorizationPrompt, 'signal'>`。

**`dsh-authorization` 的 `authorization/settled` `Events` 声明，从 `index.ts` 迁到了 `types.ts`。** 它原本和 `Context.authorization` 的 merge 声明在一起，都放在承载 cordis 逻辑的 `index.ts` 里——但 `dsh-credentials` 自己的 `credentials/reference-updated`／`credentials/record-updated` 正是按这种方式拆分的（`Events` 放 `types.ts`，`Context` 放 `index.ts`），目的就是让浏览器安全的消费方能通过 `import type {} from '.../types'` 拉取事件声明的形状，而不必加载承载 service 的那一半。`authorization/settled` 需要同样的拆分，才能满足 `packages/api/remotes/src/index.ts` 里 `API_REMOTE_FORWARDED_EVENTS` 的类型形状门禁断言。

## 曾考虑的替代方案

- **把 `Pick<IApiClient, 'authorization' | 'respond'>` 穿进 `AuthorizationPanel`**，而不是用更高层的 `IAuthorization` client-runtime service——在 `AuthorizationRuntime` 已经存在之后被否决，因为它已经处理好了 `rpcId` 的记账（`respondPrompt(rpcId, answer)`，而不是手工拼一个 `ClientResponse` envelope）以及按 key 共享的状态；直接用底层的协议接口只会把这两件事都重复实现一遍。
- **让每个 `ProviderEditor` 调用方都必须传 `authorization`**（和 `api` 是必需参数的方式一样）——被否决：`DeepSeekOnboardingDialog` 里只处理凭据的 onboarding 步骤，用不上订阅登录，而且 DeepSeek 本来就没有注册任何 flow。`ProviderEditorProps.authorization` 是可选的；只有真正需要它的调用方 `ModelsSectionInjected.authorization` 才是必需的。
- **`AuthorizationPanel` 卸载时自动取消这次尝试**——直觉上，关闭面板似乎就该停掉一个没人在看的尝试，但支持重连的共享状态设计，恰恰说明这个直觉是错的：一个人在新标签页打开 OAuth 链接、关掉 Settings 去等待，对话框一关，他正在进行的登录就会被立刻杀掉。取消操作永远只能通过那个显式按钮触发。

## 影响

每个挂载了 `dsh-authorization` 的 profile（按前一篇笔记的说法，即所有 `dsh-base` 的派生 profile），只要同时组合了 `dsh-host-apiproxy`，现在也会把它暴露在 RPC 网关上——在有调用方 `begin()` 之前保持休眠，与 CLI 路径的姿态相同。`dsh-authorization` 的包边界也随之调整：往后 `Events` 声明放在 `types.ts` 里，与 `dsh-credentials` 的先例一致，因此未来给这个 seam 添加新事件，应当遵循同样的拆分方式，而不是落在 `index.ts` 里。

浏览器和 harness host 分处两台不同机器时，依然无法自动完成 pi-ai 的 Anthropic OAuth 竞速里回调服务器那一半——`loginAnthropic()` 自己的 `auth_url` notice 已经为此准备了一个"粘贴重定向 URL"的兜底 prompt，`AuthorizationPanel` 把它当作一个普通的 `text` prompt 渲染，不做任何特殊处理。

## 测试

新增的 `packages/host/apiproxy/tests/api-proxy-authorization.spec.ts` 沿用了同级 `api-proxy-approval.spec.ts`／`api-proxy-question.spec.ts` 那种按领域分文件的模式：一个真实的 `AuthorizationService`，加上一个本地内存版 `CredentialProvider` 测试替身（与 `packages/credentials/authorization/tests/memory.ts` 自己的 `MemoryCredentials` 几乎是重复实现——那边其实早就料到会有第三份拷贝），再加一个测试专用、会执行提交的 `AuthorizationFlow`，不发起任何真实的 OAuth 网络调用。覆盖了 `list`／`begin` 的拒绝路径、notice／prompt-requested／prompt-resolved／settled 的完整序列、`respond` 的应答与拒绝、`cancel`，以及 host 流对仍处于 pending 状态的 prompt 的重连回放。`client-handler.spec.ts` 里原有的 config-unary-surface 往返测试，新增了这三个 authorization 方法，覆盖 client-carrier 那一半（`AbstractApiClient`／`toFetchHandler` 的 dispatch table）——这部分是仅靠领域测试覆盖不到的。

新增的 `packages/client/runtime/tests/authorization-service.client.spec.ts` 覆盖了 `AuthorizationManager`（refresh／seeding、全部三种 host-frame 类型、begin／cancel／respond／decline 的协议调用、结算）以及 `AuthorizationRuntime` 那层薄薄的委托加上 `ctx.reflect.provide` 注册。编写这份测试过程中发现了一个真实 bug：`declinePrompt` 缺了 `respondPrompt` 早就有的"同一 `rpcId` 仍处于 pending"这道校验，导致一次陈旧或重复的 decline 点击，会对一个已经应答过的 prompt 发出协议调用；已按同样的逻辑修复。

`packages/client/ui-settings-models/tests/` 新增了 `authorization-panel.client.spec.tsx`（method 选择、全部三种 prompt 类型、decline／cancel、begin() 与 respondPrompt() 两条失败路径，包括非 `Error` 的 rejection）和 `provider-editor-authorization.client.spec.tsx`（惰性触发的 `refreshEntries()`，以及该入口在匹配／不匹配的行上按数据决定是否显示）。编写 select 类型 prompt 的测试时，又发现了第二个真实 bug：select 选项的 `onClick` 先调用 `setDraft(option.id)`，紧接着在同一个 tick 里就去读仍然是旧值的 `draft` 闭包变量（React 的状态更新不是同步的），结果发出的是一个空答案，而不是所选选项的 id；修复方式是让 `submitPrompt` 把答案作为显式参数传入，而不是读组件状态。`provider-form.client.spec.tsx`、`components.client.spec.tsx`、`apply.client.spec.ts` 里每一个原有的 `ModelsSection`／`ProviderEditor` 测试 fixture，在 `authorization` 变成必需的 prop／inject 之后，都需要一个 `TestAuthorization` 测试替身（新增：`packages/test-support/client-runtime/src/authorization.ts`，形态照搬已有的 `TestWorkspaces`）；默认 `state: 'loaded'` 且没有 entry，这样不相关的测试既看不到登录入口，也不会触发后台 refresh。

逐文件 100% 覆盖率（`pnpm run test:coverage` 这道门禁）在这些包里，对每一个新增和改动的文件都成立，已经用范围限定的 `vitest --coverage` 运行确认过。这次工作过程中还发现了一个覆盖率工具层面的问题，它是预先存在、与本次改动无关的：在这个 sandbox 里，把 `--coverage.include` 限定到 `packages/client/runtime` 时，该包的 vitest lane 报出 0/0 行覆盖，拿一个完全没动过的既有文件（`workspaces-service.client.spec.ts`）去复现，结果一模一样——这是 sandbox／lane 本身的怪癖，不是这次改动引入的缺口。
