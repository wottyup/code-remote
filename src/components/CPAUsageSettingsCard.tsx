import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Link2, Trash2 } from 'lucide-react'
import {
  emptyCPAUsageSettings,
  normalizeCPAUsageBaseUrl,
  probeCPAUsageConnection,
  type CPAUsageSettings,
} from '../lib/cpaUsageStats'

export function CPAUsageSettingsCard({
  settings,
  onChange,
}: {
  settings: CPAUsageSettings
  onChange: (settings: CPAUsageSettings) => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [managementKey, setManagementKey] = useState(settings.managementKey)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setManagementKey(settings.managementKey)
  }, [settings.baseUrl, settings.managementKey])

  function save(nextSettings: CPAUsageSettings) {
    onChange(nextSettings)
    setBaseUrl(nextSettings.baseUrl)
    setManagementKey(nextSettings.managementKey)
  }

  async function testConnection() {
    setMessage(null)
    let nextSettings: CPAUsageSettings
    try {
      nextSettings = {
        baseUrl: normalizeCPAUsageBaseUrl(baseUrl),
        managementKey: managementKey.trim(),
      }
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '服务器地址无效。', error: true })
      return
    }

    if (!nextSettings.baseUrl || !nextSettings.managementKey) {
      setMessage({ text: '请填写 Manager Server 地址和管理密钥。', error: true })
      return
    }

    setBusy(true)
    try {
      await probeCPAUsageConnection(nextSettings)
      save(nextSettings)
      setMessage({ text: '连接成功，已验证统计接口可读取。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '连接失败，请检查设置。', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="theme-settings-card">
      <div className="theme-settings-card__heading">
        <div><h2><Link2 size={16} />CPA Manager Server 接入</h2><p>测试 Full Mode 统计接口连通性，并连接 Token 用量数据源。</p></div>
      </div>
      <div className="theme-custom-controls cpa-usage-settings-controls">
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
        <div className="cpa-usage-settings-actions">
          <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" disabled={busy} onClick={() => { void testConnection() }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {busy ? '正在测试连接…' : '测试连通性并保存'}
          </button>
          <button className="theme-notification-toggle" type="button" disabled={busy || (!settings.baseUrl && !settings.managementKey)} onClick={() => { save(emptyCPAUsageSettings); setMessage({ text: '已清除统计连接。', error: false }) }}>
            <Trash2 size={14} />清除
          </button>
        </div>
        {message ? <p className={`cpa-usage-settings-message${message.error ? ' cpa-usage-settings-message--error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
      </div>
      <p className="theme-settings-hint">地址和管理密钥保存在当前浏览器；密钥只通过 Authorization Bearer 请求头发送，不会放进 URL。Full Mode 才提供持久化历史统计；跨域时 Manager Server 需要允许当前网页来源。</p>
    </section>
  )
}
