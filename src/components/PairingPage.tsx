import { ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { codexRemoteClient, RemoteApiError } from '../lib/codexRemoteClient'

function normalizePairingCode(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[\s_\-\u200b\ufeff]+/g, '').slice(0, 8)
}

export function PairingPage({ onPaired }: { onPaired: (token: string) => void }) {
  useUiLanguage()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const cooldownRemaining = blockedUntil === null ? 0 : Math.max(0, Math.ceil((blockedUntil - clockNow) / 1000))

  useEffect(() => {
    if (blockedUntil === null) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      setClockNow(now)
      if (now >= blockedUntil) setBlockedUntil(null)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [blockedUntil])

  function startCooldown(seconds: number) {
    const now = Date.now()
    setClockNow(now)
    setBlockedUntil(now + seconds * 1000)
  }

  async function connectWithCode(value: string) {
    if (busy || cooldownRemaining > 0) return
    const normalizedCode = normalizePairingCode(value)
    if (normalizedCode.length !== 8) {
      setError('请输入有效的 8 位匹配码。')
      return
    }
    setCode(normalizedCode)
    setBusy(true)
    setError(null)
    try {
      const result = await codexRemoteClient.pair(normalizedCode)
      onPaired(result.token)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 429) {
        startCooldown(Math.max(1, reason.retryAfterSeconds ?? 60))
        setError(null)
      } else {
        setError(reason instanceof Error ? reason.message : '配对失败，请确认配对码。')
      }
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || cooldownRemaining > 0 || code.trim().length !== 8) return
    void connectWithCode(code)
  }

  return (
    <main className="pair-page">
      <section className="pair-card">
        <img className="pair-card__logo" src="/code-remote-mark.png" alt="Code Remote" />
        <p className="pair-eyebrow">CODE REMOTE</p>
        <h1>{ui("连接你的 Code Remote")}</h1>
        <p className="pair-description">{ui("在运行 Code Remote 的电脑终端里找到配对码，然后在这里输入。")}</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="pair-code">{ui("8 位配对码")}</label>
          <div className="pair-input-wrap"><KeyRound size={17} /><input
            id="pair-code"
            value={code}
            disabled={cooldownRemaining > 0}
            onChange={(event) => {
              setCode(normalizePairingCode(event.target.value))
              setError(null)
            }}
            onPaste={(event) => {
              event.preventDefault()
              setCode(normalizePairingCode(event.clipboardData.getData('text')))
              setError(null)
            }}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="done"
            maxLength={8}
            placeholder={ui("例如 A2BC7DEF")}
          /></div>
          {cooldownRemaining > 0
            ? <p className="pair-error" role="status">{uiFormat('配对已暂停；{0} 秒后可以再试。', cooldownRemaining)}</p>
            : error ? <p className="pair-error" role="alert">{uiMessage(error)}</p> : null}
          <button className="pair-submit" type="submit" disabled={busy || cooldownRemaining > 0 || code.trim().length !== 8}>
            {busy
              ? <LoaderCircle className="spin" size={17} />
              : cooldownRemaining > 0 ? uiFormat("请等待 {0} 秒", cooldownRemaining) : <>{ui("连接本机")} <ArrowRight size={16} /></>}
          </button>
        </form>
        <div className="pair-security"><ShieldCheck size={15} /><span>{ui("配对后，此浏览器即可访问电脑上的聊天会话。")}</span></div>
      </section>
    </main>
  )
}
