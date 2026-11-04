import { useEffect, useState, type FormEvent } from 'react'
import { Check, FileText, LoaderCircle, RefreshCw, Terminal } from 'lucide-react'
import {
  codexRemoteClient,
  type NativeConfigApplyStatus,
  type NativeEngine,
  type NativeEngineConfig,
} from '../lib/codexRemoteClient'
import { TranslationSelect } from './TranslationSelect'

function applyMessage(status: NativeConfigApplyStatus, engine: NativeEngine): string {
  if (engine === 'claude') return '已保存。Claude Code 下次回复会读取新配置。'
  switch (status) {
    case 'reloaded': return '已保存，Codex 已重新连接并读取新配置。'
    case 'pending': return '已保存。Codex 仍有任务、请求或未发送的新对话，处理完成后请点“重新载入 Codex”。'
    case 'next_connect': return '已保存。Codex 当前未连接，下次连接时会读取新配置。'
    case 'failed': return '配置已保存，但 Codex 重新连接失败。请检查地址和配置后再试。'
    case 'unchanged': return '配置没有变化。'
    default: return '已保存。'
  }
}

export function NativeEngineConfigCard({ token, engine, onDirtyChange }: {
  token: string
  engine: NativeEngine
  onDirtyChange: (dirty: boolean) => void
}) {
  const [config, setConfig] = useState<NativeEngineConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [authMode, setAuthMode] = useState<'bearer' | 'api_key'>('bearer')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'reload' | 'refresh' | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const title = engine === 'codex' ? 'Codex API 配置' : 'Claude Code API 配置'
  const dirty = Boolean(config && (
    baseUrl !== config.baseUrl || apiKey !== '' || authMode !== config.authMode
  ))
  const keyRequired = !config?.hasKey || authMode !== config.authMode

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void codexRemoteClient.nativeEngineConfig(token, engine, controller.signal).then((response) => {
      if (controller.signal.aborted) return
      setConfig(response)
      setBaseUrl(response.baseUrl)
      setAuthMode(response.authMode)
      setApiKey('')
      setLoading(false)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setMessage({ text: reason instanceof Error ? reason.message : '读取本机配置失败。', error: true })
      setLoading(false)
    })
    return () => controller.abort()
  }, [token, engine])

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  async function refresh() {
    if (dirty && !window.confirm('未保存的 API 配置会丢失，继续重新读取吗？')) return
    setBusy('refresh')
    setMessage(null)
    try {
      const response = await codexRemoteClient.nativeEngineConfig(token, engine)
      setConfig(response)
      setBaseUrl(response.baseUrl)
      setAuthMode(response.authMode)
      setApiKey('')
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '重新读取配置失败。', error: true })
    } finally {
      setBusy(null)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!config || busy) return
    setBusy('save')
    setMessage(null)
    try {
      const response = await codexRemoteClient.saveNativeEngineConfig(token, engine, {
        baseUrl, apiKey, authMode, expectedRevision: config.revision,
      })
      const savedUrl = baseUrl.trim().replace(/\/+$/, '')
      setConfig({
        ...config,
        exists: true,
        baseUrl: savedUrl,
        authMode,
        hasKey: true,
        enabled: true,
        currentProvider: engine === 'codex' ? 'code_remote_settings' : 'Anthropic Messages',
        revision: response.revision,
        reloadPending: response.reloadPending,
      })
      setBaseUrl(savedUrl)
      setApiKey('')
      setMessage({ text: applyMessage(response.applyStatus, engine), error: response.applyStatus === 'failed' })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '保存配置失败。', error: true })
    } finally {
      setBusy(null)
    }
  }

  async function reloadCodex() {
    if (engine !== 'codex' || busy) return
    setBusy('reload')
    setMessage(null)
    try {
      const result = await codexRemoteClient.reloadNativeCodexConfig(token)
      setConfig((current) => current ? { ...current, reloadPending: result.reloadPending } : current)
      setMessage({ text: applyMessage(result.applyStatus, engine), error: result.applyStatus === 'failed' })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '重新载入 Codex 失败。', error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="theme-settings-card theme-settings-card--page native-config" aria-label={title}>
      <div className="theme-settings-card__heading">
        <div>
          <h2>{engine === 'codex' ? <Terminal size={20} /> : <FileText size={20} />}{title}</h2>
          <p>{engine === 'codex'
            ? '设置本机 Codex 的 Responses API 地址和密钥，保存后切换默认提供方。'
            : '设置本机 Claude Code 的 Anthropic Messages API 地址和密钥。'}</p>
        </div>
      </div>
      <div className="native-config__body">
        {config ? (
          <div className="native-config__file">
            <span>本机配置文件</span>
            <code>{config.path}</code>
            {engine === 'codex' ? <small>当前文件默认提供方：{config.currentProvider || 'openai'}</small> : null}
          </div>
        ) : null}
        <form className="native-config__form" onSubmit={(event) => { void save(event) }}>
          <label className="native-config__field">
            <span>API 地址</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => { setBaseUrl(event.target.value); setMessage(null) }}
              placeholder={engine === 'codex' ? 'https://api.example.com/v1' : 'https://api.example.com'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={loading || Boolean(busy)}
              required
            />
            <small>{engine === 'codex'
              ? '须支持 OpenAI Responses API；通常填写到 /v1。'
              : '须支持 Anthropic Messages API；按服务商提供的根地址填写。'}</small>
          </label>
          {engine === 'claude' ? (
            <div className="native-config__field">
              <TranslationSelect
                label="密钥传递方式"
                value={authMode}
                options={[
                  { value: 'bearer', label: 'Bearer Token（Authorization）' },
                  { value: 'api_key', label: 'API Key（x-api-key）' },
                ]}
                disabled={loading || Boolean(busy)}
                onChange={(value) => {
                  setAuthMode(value as 'bearer' | 'api_key')
                  setApiKey('')
                  setMessage(null)
                }}
              />
              <small>不确定时可先用 Bearer Token；接口文档要求 x-api-key 时选择 API Key。</small>
            </div>
          ) : null}
          <label className="native-config__field">
            <span>API 密钥{config?.hasKey && !keyRequired ? <em>已配置 · 留空保留原密钥</em> : null}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setMessage(null) }}
              placeholder={keyRequired ? '输入 API 密钥' : '留空保留已保存的密钥'}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={loading || Boolean(busy)}
              required={keyRequired}
            />
          </label>
          <div className="native-config__actions">
            <button className="theme-notification-toggle theme-notification-toggle--enabled" type="submit" disabled={!config || loading || Boolean(busy) || !dirty}>
              {busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {busy === 'save' ? '正在保存…' : '保存并应用'}
            </button>
            <button className="theme-notification-toggle" type="button" disabled={loading || Boolean(busy)} onClick={() => { void refresh() }}>
              {busy === 'refresh' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              重新读取
            </button>
            {engine === 'codex' && config?.reloadPending ? (
              <button className="theme-notification-toggle" type="button" disabled={Boolean(busy)} onClick={() => { void reloadCodex() }}>
                {busy === 'reload' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                重新载入 Codex
              </button>
            ) : null}
          </div>
        </form>
        {loading ? <p className="native-config__message" role="status">正在读取本机配置…</p> : null}
        {engine === 'codex' && config?.reloadPending && !message ? <p className="native-config__message" role="status">配置已保存，Codex 尚未重新载入。空闲后点“重新载入 Codex”。</p> : null}
        {message ? <p className={'native-config__message' + (message.error ? ' native-config__message--error' : '')} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
        {baseUrl.trim().startsWith('http://') ? <p className="native-config__hint">HTTP 连接会明文传输密钥；远程接口建议使用 HTTPS。</p> : null}
        <p className="native-config__hint">密钥写入本机 CLI 配置文件。拥有该系统账号文件读取权限的程序也能读取它；网页不会回显或持久保存密钥。</p>
        <p className="native-config__hint">保存只更新本机配置，不检测接口连通性或模型是否受支持。已打开的独立 CLI 会话可能需要重新启动。</p>
      </div>
    </section>
  )
}
