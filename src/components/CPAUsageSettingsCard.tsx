import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Link2, Trash2 } from 'lucide-react'
import { codexRemoteClient } from '../lib/codexRemoteClient'
import {
  emptyCPAUsageSettings,
  normalizeCPAUsageBaseUrl,
  type CPAUsageSettings,
} from '../lib/cpaUsageStats'

export function CPAUsageSettingsCard({
  token,
  settings,
  loading,
  loadError,
  onRetry,
  onChange,
}: {
  token: string
  settings: CPAUsageSettings
  loading: boolean
  loadError: string | null
  onRetry: () => void
  onChange: (settings: CPAUsageSettings) => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [managementKey, setManagementKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setManagementKey('')
  }, [settings.baseUrl, settings.configured])

  async function testConnection() {
    setMessage(null)
    let nextCredentials: { baseUrl: string; managementKey: string }
    try {
      nextCredentials = {
        baseUrl: normalizeCPAUsageBaseUrl(baseUrl),
        managementKey: managementKey.trim(),
      }
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '服务器地址无效。', error: true })
      return
    }

    if (!nextCredentials.baseUrl) {
      setMessage({ text: '请填写 Manager Server 地址。', error: true })
      return
    }
    if (!nextCredentials.managementKey && (!settings.configured || nextCredentials.baseUrl !== settings.baseUrl)) {
      setMessage({ text: '首次连接或修改服务器地址时，请填写 Manager 管理密钥。', error: true })
      return
    }

    setBusy(true)
    try {
      const saved = await codexRemoteClient.saveCPAUsageSettings(token, nextCredentials)
      onChange(saved)
      setManagementKey('')
      setMessage({ text: '连接成功，已验证统计接口可读取。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '连接失败，请检查设置。', error: true })
    } finally {
      setBusy(false)
    }
  }

  async function clearSettings() {
    setMessage(null)
    setBusy(true)
    try {
      await codexRemoteClient.clearCPAUsageSettings(token)
      onChange(emptyCPAUsageSettings)
      setManagementKey('')
      setMessage({ text: '已清除服务端共享的统计连接。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '清除连接失败。', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="theme-settings-card">
      <div className="theme-settings-card__heading">
        <div><h2><Link2 size={16} />CPA Manager Server 接入</h2><p>测试 Full Mode 统计接口连通性，并让所有已配对设备共用此连接。</p></div>
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
            disabled={loading || busy}
            placeholder="https://你的服务器域名"
            value={baseUrl}
            onChange={(event) => { setBaseUrl(event.target.value); setMessage(null) }}
            aria-label="CPA-Manager-Plus Manager Server 地址"
          />
        </label>
        <label className="theme-control-row theme-control-row--stacked">
          <span><strong>Manager 管理密钥</strong><small>密钥由 Codex Remote 服务端保存；浏览器只在提交配置时发送，同一服务下的已配对设备共用。不是 Codex 调用模型使用的 API key。</small></span>
          <input
            className="cpa-usage-settings-input"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={loading || busy}
            placeholder={settings.configured ? '已配置，留空可保留现有密钥' : '输入 Manager 管理密钥'}
            value={managementKey}
            onChange={(event) => { setManagementKey(event.target.value); setMessage(null) }}
            aria-label="CPA Manager Server 管理密钥"
          />
        </label>
        <div className="cpa-usage-settings-actions">
          <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" disabled={loading || busy} onClick={() => { void testConnection() }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {loading ? '正在读取共享设置…' : busy ? '正在测试连接…' : '测试连通性并保存'}
          </button>
          <button className="theme-notification-toggle" type="button" disabled={loading || busy || !settings.configured} onClick={() => { void clearSettings() }}>
            <Trash2 size={14} />清除
          </button>
        </div>
        {loadError ? (
          <div className="cpa-usage-settings-load-error" role="alert">
            <p className="cpa-usage-settings-message cpa-usage-settings-message--error">暂时无法确认 Codex Remote 服务端的共享配置：{loadError} 请重试读取。</p>
            <button className="theme-notification-toggle" type="button" disabled={loading || busy} onClick={onRetry}>重新读取</button>
          </div>
        ) : null}
        {message ? <p className={`cpa-usage-settings-message${message.error ? ' cpa-usage-settings-message--error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
      </div>
      <p className="theme-settings-hint">地址和管理密钥保存在 Codex Remote 服务端；统计请求由后端转发，管理密钥不会写入浏览器本地存储或由服务端回传。Full Mode 才提供持久化历史统计。</p>
    </section>
  )
}
