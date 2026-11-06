import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Link2, Trash2 } from 'lucide-react'
import {
  normalizeCPAUsageBaseUrl,
  normalizeCodexProxyBaseUrl,
  probeCPAUsageConnection,
  probeCodexProxyUsageConnection,
  type CPAUsageSettings,
} from '../lib/cpaUsageStats'

export function CPAUsageSettingsCard({
  settings,
  token,
  onChange,
}: {
  settings: CPAUsageSettings
  token: string
  onChange: (settings: CPAUsageSettings) => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [managementKey, setManagementKey] = useState(settings.managementKey)
  const [codexProxyBaseUrl, setCodexProxyBaseUrl] = useState(settings.codexProxyBaseUrl)
  const [codexProxyApiKey, setCodexProxyApiKey] = useState(settings.codexProxyApiKey)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setManagementKey(settings.managementKey)
    setCodexProxyBaseUrl(settings.codexProxyBaseUrl)
    setCodexProxyApiKey(settings.codexProxyApiKey)
  }, [settings.baseUrl, settings.managementKey, settings.codexProxyBaseUrl, settings.codexProxyApiKey])

  function save(nextSettings: CPAUsageSettings) {
    onChange(nextSettings)
    setBaseUrl(nextSettings.baseUrl)
    setManagementKey(nextSettings.managementKey)
    setCodexProxyBaseUrl(nextSettings.codexProxyBaseUrl)
    setCodexProxyApiKey(nextSettings.codexProxyApiKey)
  }

  async function testConnection() {
    setMessage(null)
    let nextSettings: CPAUsageSettings
    try {
      nextSettings = settings.source === 'codex-proxy'
        ? { ...settings, codexProxyBaseUrl: normalizeCodexProxyBaseUrl(codexProxyBaseUrl), codexProxyApiKey: codexProxyApiKey.trim() }
        : { ...settings, baseUrl: normalizeCPAUsageBaseUrl(baseUrl), managementKey: managementKey.trim() }
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '服务器地址无效。', error: true })
      return
    }

    if (settings.source === 'codex-proxy'
      ? !nextSettings.codexProxyBaseUrl || !nextSettings.codexProxyApiKey
      : !nextSettings.baseUrl || !nextSettings.managementKey) {
      setMessage({ text: settings.source === 'codex-proxy' ? '请填写 Codex Proxy 地址和主 Proxy API Key。' : '请填写 Manager Server 地址和管理密钥。', error: true })
      return
    }

    setBusy(true)
    try {
      if (settings.source === 'codex-proxy') await probeCodexProxyUsageConnection(nextSettings, token)
      else await probeCPAUsageConnection(nextSettings)
      save(nextSettings)
      setMessage({ text: '连接成功，已验证统计接口可读取。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '连接失败，请检查设置。', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="theme-settings-card theme-settings-card--page" aria-label="token使用量查询">
      <div className="theme-settings-card__heading">
        <div><h2><Link2 size={16} />token使用量查询</h2><p>选择统计来源，测试连接并保存对应配置。</p></div>
      </div>
      <div className="theme-custom-controls cpa-usage-settings-controls">
        <div className="cpa-usage-range-tabs cpa-usage-source-tabs" role="group" aria-label="Token 用量数据源">
          <button type="button" className={settings.source === 'cpamp' ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={settings.source === 'cpamp'} onClick={() => { onChange({ ...settings, source: 'cpamp' }); setMessage(null) }}>CPA-Manager-Plus</button>
          <button type="button" className={settings.source === 'codex-proxy' ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={settings.source === 'codex-proxy'} onClick={() => { onChange({ ...settings, source: 'codex-proxy' }); setMessage(null) }}>Codex Proxy</button>
        </div>
        {settings.source === 'codex-proxy' ? <>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>Codex Proxy 地址</strong><small>填写控制面板的服务根地址，例如 http://192.168.1.10:8080。</small></span>
            <input className="cpa-usage-settings-input" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="http://你的服务器:8080" value={codexProxyBaseUrl} onChange={(event) => { setCodexProxyBaseUrl(event.target.value); setMessage(null) }} aria-label="Codex Proxy 地址" />
          </label>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>主 Proxy API Key</strong><small>使用 Codex Proxy 控制面板显示的主 API Key，普通 Client Key 无法读取管理统计。</small></span>
            <input className="cpa-usage-settings-input" type="password" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="输入主 Proxy API Key" value={codexProxyApiKey} onChange={(event) => { setCodexProxyApiKey(event.target.value); setMessage(null) }} aria-label="Codex Proxy 主 API Key" />
          </label>
        </> : <>
        <label className="theme-control-row theme-control-row--stacked">
          <span><strong>Manager Server 地址</strong><small>填写服务根地址或反向代理前缀，不要带 /management.html，例如 https://example.com/cpamp。</small></span>
          <input
            className="cpa-usage-settings-input"
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://你的服务器域名"
            value={baseUrl}
            onChange={(event) => { setBaseUrl(event.target.value); setMessage(null) }}
            aria-label="CPA-Manager-Plus Manager Server 地址"
          />
        </label>
        <label className="theme-control-row theme-control-row--stacked">
          <span><strong>Manager 管理密钥</strong><small>用于访问 Manager 管理接口；不是本机 Codex 调用模型时使用的 API key。</small></span>
          <input
            className="cpa-usage-settings-input"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="输入 Manager 管理密钥"
            value={managementKey}
            onChange={(event) => { setManagementKey(event.target.value); setMessage(null) }}
            aria-label="CPA Manager Server 管理密钥"
          />
        </label>
        </>}
        <div className="cpa-usage-settings-actions">
          <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" disabled={busy} onClick={() => { void testConnection() }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {busy ? '正在测试连接…' : '测试连通性并保存'}
          </button>
          <button className="theme-notification-toggle" type="button" disabled={busy || (settings.source === 'codex-proxy' ? !settings.codexProxyBaseUrl && !settings.codexProxyApiKey : !settings.baseUrl && !settings.managementKey)} onClick={() => { save(settings.source === 'codex-proxy' ? { ...settings, codexProxyBaseUrl: '', codexProxyApiKey: '' } : { ...settings, baseUrl: '', managementKey: '' }); setMessage({ text: '已清除当前数据源连接。', error: false }) }}>
            <Trash2 size={14} />清除
          </button>
        </div>
        {message ? <p className={`cpa-usage-settings-message${message.error ? ' cpa-usage-settings-message--error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
      </div>
      <p className="theme-settings-hint">{settings.source === 'codex-proxy'
        ? '地址和主 API Key 保存在当前浏览器，并经已配对的 Code Remote 后端读取 Codex Proxy 管理接口。密钥不会放入 URL。历史用量依赖 Codex Proxy 已记录的快照。'
        : '地址和管理密钥保存在当前浏览器；密钥只通过 Authorization Bearer 请求头发送，不会放进 URL。Full Mode 才提供持久化历史统计；跨域时 Manager Server 需要允许当前网页来源。'}</p>
    </section>
  )
}
