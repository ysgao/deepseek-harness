/**
 * Generic authorization-flow surface: renders `ctx.authorization`'s neutral
 * notice/prompt vocabulary for one credential key, with no per-flow (OAuth,
 * device-code, …) knowledge of its own — the same posture the seam's own
 * doc states ("a surface that renders one flow renders all of them"). Method
 * choice, notices, and the current prompt are all it needs to drive any
 * registered flow to completion.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationEntry } from '@deepseek-ai/dsh-authorization/types'
import type { AuthorizationKeyState, IAuthorization } from './authorization-runtime.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link AuthorizationPanel}. */
export interface AuthorizationPanelProps {
  /** The flow this panel drives. */
  entry: AuthorizationEntry
  /** Live push state for this flow's key. */
  keyState: AuthorizationKeyState
  /** The subset of `ctx.authorization` this panel calls. */
  authorization: Pick<IAuthorization, 'begin' | 'cancel' | 'respondPrompt' | 'declinePrompt'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every action (read-only settings provider). */
  disabled?: boolean
}

/** Render one authorization attempt's notices and prompts, and drive its start/answer/cancel actions. */
export function AuthorizationPanel(props: AuthorizationPanelProps): ReactNode {
  const { entry, keyState, authorization, t } = props
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const disabled = props.disabled === true || busy

  const start = async (chosen: string): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await authorization.begin(entry.key, chosen)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      await authorization.cancel(entry.key)
    } finally {
      setBusy(false)
    }
  }

  // Takes the answer explicitly rather than reading `draft` from closure: a
  // select option's click handler cannot set the draft and read it back in
  // the same tick, since setDraft is an async state update.
  const submitPrompt = async (answer: string): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await authorization.respondPrompt(entry.key, answer)
      setDraft('')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const declinePrompt = async (): Promise<void> => {
    setBusy(true)
    try {
      await authorization.declinePrompt(entry.key)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  if (!keyState.inFlight) {
    // Not started: a single method starts directly, several offer a choice
    // first (mirrors the terminal interaction's numbered method list).
    if (entry.methods.length === 1) {
      // Cast, not `?.`/`??`: the length check just above already proves
      // index 0 exists, and an optional-chained fallback would be dead code
      // the per-file coverage gate can never reach.
      const only = entry.methods[0] as { id: string; label: string }
      return (
        <div className={styles['field']}>
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={disabled}
            onClick={() => { void start(only.id) }}
          >
            {only.label}
          </button>
          {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
        </div>
      )
    }
    return (
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('signInChooseMethod')}</span>
        {entry.methods.map(candidate => (
          <button
            key={candidate.id}
            type="button"
            className={styles['secondaryButton']}
            disabled={disabled}
            onClick={() => { void start(candidate.id) }}
          >
            {candidate.label}
          </button>
        ))}
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      </div>
    )
  }

  const prompt = keyState.pendingPrompt
  return (
    <div className={styles['field']}>
      {keyState.notices.map((notice, index) => (
        // Notices accumulate for the life of one attempt; index is stable
        // because nothing reorders or removes an earlier notice.
        <p key={index} className={styles['advancedHint']}>
          {notice.message}
          {notice.url === undefined ? null : (
            <>
              {' '}
              <a className={styles['linkButton']} href={notice.url} target="_blank" rel="noreferrer">{notice.url}</a>
            </>
          )}
          {notice.code === undefined ? null : ` (${notice.code})`}
        </p>
      ))}
      {prompt === undefined
        ? null
        : (
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{prompt.prompt.message}</span>
            {prompt.prompt.kind === 'select'
              ? prompt.prompt.options.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={styles['secondaryButton']}
                  disabled={disabled}
                  onClick={() => { void submitPrompt(option.id) }}
                >
                  {option.label}
                </button>
              ))
              : (
                <>
                  <input
                    className={styles['input']}
                    type={prompt.prompt.kind === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    value={draft}
                    placeholder={prompt.prompt.placeholder}
                    aria-label={prompt.prompt.message}
                    disabled={disabled}
                    onChange={(event) => { setDraft(event.target.value) }}
                  />
                  <button
                    type="button"
                    className={styles['primaryButton']}
                    disabled={disabled || draft.length === 0}
                    onClick={() => { void submitPrompt(draft) }}
                  >
                    {t('signInSubmit')}
                  </button>
                </>
              )}
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={disabled}
              onClick={() => { void declinePrompt() }}
            >
              {t('signInDecline')}
            </button>
          </div>
        )}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={() => { void cancel() }}>
        {t('signInCancel')}
      </button>
    </div>
  )
}
