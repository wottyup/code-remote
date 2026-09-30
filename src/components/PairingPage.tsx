import { useState, type FormEvent } from 'react'
import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { codexRemoteClient } from '../lib/codexRemoteClient'

export function PairingPage({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || code.trim().length < 6) return
    setBusy(true)
    setError(null)
    try {
      const result = await codexRemoteClient.pair(code)
      onPaired(result.token)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '配对失败，请确认配对码。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pair-page">
      <section className="pair-card">
        <div className="pair-card__mark">C</div>
        <p className="pair-eyebrow">LOCAL CODEX SESSION</p>
        <h1>连接你的本机 Codex</h1>
        <p className="pair-description">在运行 Codex Remote 的电脑终端里找到配对码，然后在这里输入。</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="pair-code">8 位配对码</label>
          <div className="pair-input-wrap"><KeyRound size={17} /><input id="pair-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoComplete="one-time-code" autoCapitalize="characters" maxLength={8} placeholder="例如 A2BC7DEF" /></div>
          {error ? <p className="pair-error" role="alert">{error}</p> : null}
          <button className="pair-submit" type="submit" disabled={busy || code.trim().length < 6}>{busy ? <LoaderCircle className="spin" size={17} /> : <>连接本机 <ArrowRight size={16} /></>}</button>
        </form>
        <div className="pair-security"><ShieldCheck size={15} /><span>配对后，此浏览器即可访问本机 Codex 会话。</span></div>
      </section>
    </main>
  )
}
