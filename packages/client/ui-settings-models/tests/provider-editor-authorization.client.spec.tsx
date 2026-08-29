// @vitest-environment jsdom
/** ProviderEditor's Sign-in affordance: data-driven visibility and the lazy refreshEntries() load. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { TestAuthorization } from './test-authorization.client.ts'
import type { JsonValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

function piAiNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fakeApi() {
  return {
    settings: { mutate: vi.fn(() => Promise.resolve(ok({ ns: 'llm-pi-ai', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 1 }))) },
    credentials: { describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))), set: vi.fn() },
    llm: { discoverModels: vi.fn() },
  }
}

function authEntry(key: string) {
  return { key: key as never, label: 'Anthropic (Claude Pro/Max)', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false }
}

describe('ProviderEditor authorization affordance', () => {
  it('triggers refreshEntries() once on mount while the list is idle', async () => {
    const authorization = new TestAuthorization(async (fn) => { await fn() })
    // The double defaults to 'loaded' (most tests want no background refresh
    // noise); this case exercises the genuinely-idle mount path instead.
    await authorization.update((draft) => { draft.state = 'idle' })
    render(<ProviderEditor
      provider="openai" displayName="openai" namespace={piAiNamespace()} schema={settingsSchema}
      settingsPath={['providers', 'openai']} api={fakeApi() as never} authorization={authorization} t={t}
      readOnly={false} onClose={() => {}}
    />)
    expect(authorization.calls.filter(call => call.method === 'refreshEntries')).toHaveLength(1)
  })

  it('shows the Sign-in affordance only when the registry has a flow for this row\'s derived key', async () => {
    const authorization = new TestAuthorization(async (fn) => { await fn() })
    await authorization.update((draft) => {
      draft.state = 'loaded'
      draft.entries = [authEntry('llm-pi-ai/openai')]
      draft.byKey = { 'llm-pi-ai/openai': { inFlight: false, notices: [], pendingPrompt: undefined } }
    })
    render(<ProviderEditor
      provider="openai" displayName="openai" namespace={piAiNamespace()} schema={settingsSchema}
      settingsPath={['providers', 'openai']} api={fakeApi() as never} authorization={authorization} t={t}
      readOnly={false} onClose={() => {}}
    />)
    const button = await screen.findByText('Sign in')
    fireEvent.click(button)
    expect(authorization.calls.filter(call => call.method === 'begin')).toEqual([
      { method: 'begin', args: ['llm-pi-ai/openai', 'oauth'] },
    ])
    // Refresh is skipped once the list is no longer idle.
    expect(authorization.calls.filter(call => call.method === 'refreshEntries')).toHaveLength(0)
  })

  it('shows no Sign-in affordance for a route the registry names no flow for', async () => {
    const authorization = new TestAuthorization(async (fn) => { await fn() })
    await authorization.update((draft) => {
      draft.state = 'loaded'
      draft.entries = [authEntry('llm-pi-ai/anthropic')]
    })
    render(<ProviderEditor
      provider="openai" displayName="openai" namespace={piAiNamespace()} schema={settingsSchema}
      settingsPath={['providers', 'openai']} api={fakeApi() as never} authorization={authorization} t={t}
      readOnly={false} onClose={() => {}}
    />)
    await screen.findByLabelText(en.keyInput)
    expect(screen.queryByText('Sign in')).toBeNull()
  })

  it('renders no affordance and never calls refreshEntries when authorization is absent (onboarding reuse)', () => {
    render(<ProviderEditor
      provider="deepseek-official" displayName="DeepSeek" namespace={piAiNamespace()} schema={settingsSchema}
      settingsPath={['providers', 'openai']} api={fakeApi() as never} t={t}
      readOnly={false} credentialOnly onClose={() => {}}
    />)
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
  })
})
