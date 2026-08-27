// @vitest-environment jsdom
/** Generic authorization-flow surface: method choice, notices, prompt kinds, cancel/decline. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationEntry, AuthorizationKeyState } from '@deepseek-ai/dsh-client-runtime/client'
import { AuthorizationPanel } from '../src/client/AuthorizationPanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

const KEY = 'llm-pi-ai/anthropic' as AuthorizationEntry['key']

function entry(methods: AuthorizationEntry['methods']): AuthorizationEntry {
  return { key: KEY, label: 'Anthropic', methods, inFlight: false }
}

function idle(): AuthorizationKeyState {
  return { inFlight: false, notices: [], pendingPrompt: undefined }
}

function inFlight(over: Partial<AuthorizationKeyState> = {}): AuthorizationKeyState {
  return { inFlight: true, notices: [], pendingPrompt: undefined, ...over }
}

function authorization() {
  return {
    begin: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    respondPrompt: vi.fn(() => Promise.resolve()),
    declinePrompt: vi.fn(() => Promise.resolve()),
  }
}

describe('AuthorizationPanel', () => {
  it('a single method renders its own label as the sign-in button and begins with its id', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in with Anthropic' }])}
      keyState={idle()} authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText('Sign in with Anthropic'))
    expect(auth.begin).toHaveBeenCalledWith(KEY, 'oauth')
  })

  it('several methods render a choice; picking one begins with that method', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'Paste a key' }])}
      keyState={idle()} authorization={auth} t={t}
    />)
    expect(screen.getByText(en.signInChooseMethod)).toBeTruthy()
    fireEvent.click(screen.getByText('Paste a key'))
    expect(auth.begin).toHaveBeenCalledWith(KEY, 'api-key')
  })

  it('shows the begin() rejection message beside the not-started affordance', async () => {
    const auth = authorization()
    auth.begin.mockRejectedValueOnce(new Error('already in flight'))
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={idle()} authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText('Sign in'))
    await screen.findByText('already in flight')
  })

  it('stringifies a non-Error begin() rejection', async () => {
    const auth = authorization()
    auth.begin.mockRejectedValueOnce('transport down')
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={idle()} authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText('Sign in'))
    await screen.findByText('transport down')
  })

  it('shows the respondPrompt() rejection message beside the prompt', async () => {
    const auth = authorization()
    auth.respondPrompt.mockRejectedValueOnce(new Error('stale attempt'))
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ pendingPrompt: { rpcId: 'p1' as never, prompt: { kind: 'text', message: 'Code' } } })}
      authorization={auth} t={t}
    />)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText(en.signInSubmit))
    await screen.findByText('stale attempt')
  })

  it('stringifies a non-Error respondPrompt() rejection', async () => {
    const auth = authorization()
    auth.respondPrompt.mockRejectedValueOnce('transport down')
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ pendingPrompt: { rpcId: 'p1' as never, prompt: { kind: 'text', message: 'Code' } } })}
      authorization={auth} t={t}
    />)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText(en.signInSubmit))
    await screen.findByText('transport down')
  })

  it('shows the begin() rejection message beside a multi-method choice too', async () => {
    const auth = authorization()
    auth.begin.mockRejectedValueOnce(new Error('busy'))
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'Paste a key' }])}
      keyState={idle()} authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText('OAuth'))
    await screen.findByText('busy')
  })

  it('renders a bare notice with neither a url nor a code', () => {
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ notices: [{ message: 'Signing in…' }] })}
      authorization={authorization()} t={t}
    />)
    expect(screen.getByText('Signing in…')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders an in-flight notice with its url link and code', () => {
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ notices: [{ message: 'Open this page', url: 'https://claude.ai/oauth', code: 'ABCD' }] })}
      authorization={authorization()} t={t}
    />)
    expect(screen.getByText(/Open this page/)).toBeTruthy()
    const link = screen.getByText('https://claude.ai/oauth') as HTMLAnchorElement
    expect(link.href).toBe('https://claude.ai/oauth')
    expect(screen.getByText(/\(ABCD\)/)).toBeTruthy()
  })

  it('a text prompt submits the typed answer and clears the draft', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ pendingPrompt: { rpcId: 'p1' as never, prompt: { kind: 'text', message: 'Paste the redirect URL' } } })}
      authorization={auth} t={t}
    />)
    const input = screen.getByLabelText('Paste the redirect URL') as HTMLInputElement
    expect(input.type).toBe('text')
    fireEvent.change(input, { target: { value: 'https://callback/?code=x' } })
    fireEvent.click(screen.getByText(en.signInSubmit))
    expect(auth.respondPrompt).toHaveBeenCalledWith('p1', 'https://callback/?code=x')
  })

  it('a secret prompt masks the input', () => {
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ pendingPrompt: { rpcId: 'p1' as never, prompt: { kind: 'secret', message: 'Enter your key' } } })}
      authorization={authorization()} t={t}
    />)
    const input = screen.getByLabelText('Enter your key') as HTMLInputElement
    expect(input.type).toBe('password')
  })

  it('a select prompt renders each option as a button and answers with its id', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({
        pendingPrompt: {
          rpcId: 'p1' as never,
          prompt: { kind: 'select', message: 'Pick an account', options: [{ id: 'a', label: 'Account A' }, { id: 'b', label: 'Account B' }] },
        },
      })}
      authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText('Account B'))
    expect(auth.respondPrompt).toHaveBeenCalledWith('p1', 'b')
  })

  it('decline calls declinePrompt with the pending rpcId', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight({ pendingPrompt: { rpcId: 'p1' as never, prompt: { kind: 'text', message: 'Code' } } })}
      authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText(en.signInDecline))
    expect(auth.declinePrompt).toHaveBeenCalledWith('p1')
  })

  it('cancel calls cancel with the entry key while in flight, with no pending prompt required', async () => {
    const auth = authorization()
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={inFlight()} authorization={auth} t={t}
    />)
    fireEvent.click(screen.getByText(en.signInCancel))
    expect(auth.cancel).toHaveBeenCalledWith(KEY)
  })

  it('disables every action when disabled is set', () => {
    render(<AuthorizationPanel
      entry={entry([{ id: 'oauth', label: 'Sign in' }])}
      keyState={idle()} authorization={authorization()} t={t} disabled
    />)
    expect(screen.getByText('Sign in').closest('button')?.disabled).toBe(true)
  })
})
