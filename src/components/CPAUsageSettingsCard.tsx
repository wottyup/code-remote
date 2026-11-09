import { ui, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Link2, Trash2 } from 'lucide-react'
import {
  normalizeCPAUsageBaseUrl,
  normalizeCodexProxyBaseUrl,
  normalizeNewAPIBaseUrl,
  normalizeNewAPIUserId,
  probeCPAUsageConnection,
  probeCodexProxyUsageConnection,
  probeNewAPIUsageConnection,
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
  useUiLanguage()
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [managementKey, setManagementKey] = useState(settings.managementKey)
  const [codexProxyBaseUrl, setCodexProxyBaseUrl] = useState(settings.codexProxyBaseUrl)
  const [codexProxyApiKey, setCodexProxyApiKey] = useState(settings.codexProxyApiKey)
  const [newAPIBaseUrl, setNewAPIBaseUrl] = useState(settings.newAPIBaseUrl)
  const [newAPIAccessToken, setNewAPIAccessToken] = useState(settings.newAPIAccessToken)
  const [newAPIUserId, setNewAPIUserId] = useState(settings.newAPIUserId)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setManagementKey(settings.managementKey)
    setCodexProxyBaseUrl(settings.codexProxyBaseUrl)
    setCodexProxyApiKey(settings.codexProxyApiKey)
    setNewAPIBaseUrl(settings.newAPIBaseUrl)
    setNewAPIAccessToken(settings.newAPIAccessToken)
    setNewAPIUserId(settings.newAPIUserId)
  }, [settings.baseUrl, settings.managementKey, settings.codexProxyBaseUrl, settings.codexProxyApiKey, settings.newAPIBaseUrl, settings.newAPIAccessToken, settings.newAPIUserId])

  function save(nextSettings: CPAUsageSettings) {
    onChange(nextSettings)
    setBaseUrl(nextSettings.baseUrl)
    setManagementKey(nextSettings.managementKey)
    setCodexProxyBaseUrl(nextSettings.codexProxyBaseUrl)
    setCodexProxyApiKey(nextSettings.codexProxyApiKey)
    setNewAPIBaseUrl(nextSettings.newAPIBaseUrl)
    setNewAPIAccessToken(nextSettings.newAPIAccessToken)
    setNewAPIUserId(nextSettings.newAPIUserId)
  }

  async function testConnection() {
    setMessage(null)
    let nextSettings: CPAUsageSettings
    try {
      nextSettings = settings.source === 'codex-proxy'
        ? { ...settings, codexProxyBaseUrl: normalizeCodexProxyBaseUrl(codexProxyBaseUrl), codexProxyApiKey }
        : settings.source === 'new-api'
          ? { ...settings, newAPIBaseUrl: normalizeNewAPIBaseUrl(newAPIBaseUrl), newAPIAccessToken: newAPIAccessToken.trim(), newAPIUserId: normalizeNewAPIUserId(newAPIUserId) }
          : { ...settings, baseUrl: normalizeCPAUsageBaseUrl(baseUrl), managementKey: managementKey.trim() }
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '服务器地址无效。', error: true })
      return
    }

    if (settings.source === 'codex-proxy'
      ? !nextSettings.codexProxyBaseUrl || !nextSettings.codexProxyApiKey
      : settings.source === 'new-api'
        ? !nextSettings.newAPIBaseUrl || !nextSettings.newAPIAccessToken
        : !nextSettings.baseUrl || !nextSettings.managementKey) {
      setMessage({ text: settings.source === 'codex-proxy' ? '请填写 Codex Proxy 地址和控制面板登录密码。' : settings.source === 'new-api' ? '请填写 New API 地址和面板个人访问令牌。' : '请填写 Manager Server 地址和管理密钥。', error: true })
      return
    }

    setBusy(true)
    try {
      let clientKeysError: string | undefined
      if (settings.source === 'codex-proxy') clientKeysError = (await probeCodexProxyUsageConnection(nextSettings, token)).clientKeysError
      else if (settings.source === 'new-api') await probeNewAPIUsageConnection(nextSettings, token)
      else await probeCPAUsageConnection(nextSettings)
      save(nextSettings)
      setMessage(clientKeysError
        ? { text: `连接成功，但各 Key 用量暂不可用：${clientKeysError}`, error: true }
        : { text: '连接成功，已验证统计接口可读取。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '连接失败，请检查设置。', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="theme-settings-card theme-settings-card--page" aria-label={ui("token使用量查询")}>
      <div className="theme-settings-card__heading">
        <div><h2><Link2 size={16} />{ui("token使用量查询")}</h2><p>{ui("选择统计来源，测试连接并保存对应配置。")}</p></div>
      </div>
      <div className="theme-custom-controls cpa-usage-settings-controls">
        <div className="cpa-usage-range-tabs cpa-usage-source-tabs" role="group" aria-label={ui("Token 用量数据源")}>
          <button type="button" className={settings.source === 'cpamp' ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={settings.source === 'cpamp'} onClick={() => { onChange({ ...settings, source: 'cpamp' }); setMessage(null) }}>CPA-Manager-Plus</button>
          <button type="button" className={settings.source === 'codex-proxy' ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={settings.source === 'codex-proxy'} onClick={() => { onChange({ ...settings, source: 'codex-proxy' }); setMessage(null) }}>Codex Proxy</button>
          <button type="button" className={settings.source === 'new-api' ? 'cpa-usage-range-tabs__active' : ''} aria-pressed={settings.source === 'new-api'} onClick={() => { onChange({ ...settings, source: 'new-api' }); setMessage(null) }}>New API</button>
        </div>
        {settings.source === 'codex-proxy' ? <>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>{ui("Codex Proxy 地址")}</strong><small>{ui("填写控制面板的服务根地址，例如 http://192.168.1.10:8080。")}</small></span>
            <input className="cpa-usage-settings-input" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={ui("http://你的服务器:8080")} value={codexProxyBaseUrl} onChange={(event) => { setCodexProxyBaseUrl(event.target.value); setMessage(null) }} aria-label={ui("Codex Proxy 地址")} />
          </label>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>{ui("控制面板登录密码（主 API Key）")}</strong><small>{ui("Codex Proxy 的后台登录密码和主 API Key 是同一个值；成员使用的 Client Key 无法读取全部统计。")}</small></span>
            <input className="cpa-usage-settings-input" type="password" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={ui("输入 Codex Proxy 后台登录密码")} value={codexProxyApiKey} onChange={(event) => { setCodexProxyApiKey(event.target.value); setMessage(null) }} aria-label={ui("Codex Proxy 控制面板登录密码")} />
          </label>
        </> : settings.source === 'new-api' ? <>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>{ui("New API 地址")}</strong><small>{ui("填写 New API 面板的服务根地址，例如 https://api.example.com。")}</small></span>
            <input className="cpa-usage-settings-input" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={ui("https://你的 New API 地址")} value={newAPIBaseUrl} onChange={(event) => { setNewAPIBaseUrl(event.target.value); setMessage(null) }} aria-label={ui("New API 地址")} />
          </label>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>{ui("面板访问令牌")}</strong><small>{ui("rc.21 在“个人资料 → 安全 → 访问令牌”获取，打开时会重新生成令牌；新版使用有 usage:read 权限的个人访问令牌。")}</small></span>
            <input className="cpa-usage-settings-input" type="password" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={ui("输入面板访问令牌，不是登录密码")} value={newAPIAccessToken} onChange={(event) => { setNewAPIAccessToken(event.target.value); setMessage(null) }} aria-label={ui("New API 面板访问令牌")} />
          </label>
          <label className="theme-control-row theme-control-row--stacked">
            <span><strong>{ui("用户 ID（旧版需要）")}</strong><small>{ui("在 New API 的“个人资料”页顶部查看用户 ID；新版如不要求用户 ID 可以留空。")}</small></span>
            <input className="cpa-usage-settings-input" type="text" inputMode="numeric" maxLength={18} autoComplete="off" placeholder={ui("例如 1")} value={newAPIUserId} onChange={(event) => { setNewAPIUserId(event.target.value); setMessage(null) }} aria-label={ui("New API 用户 ID")} />
          </label>
        </> : <>
        <label className="theme-control-row theme-control-row--stacked">
          <span><strong>{ui("Manager Server 地址")}</strong><small>{ui("填写服务根地址或反向代理前缀，不要带 /management.html，例如 https://example.com/cpamp。")}</small></span>
          <input
            className="cpa-usage-settings-input"
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={ui("https://你的服务器域名")}
            value={baseUrl}
            onChange={(event) => { setBaseUrl(event.target.value); setMessage(null) }}
            aria-label={ui("CPA-Manager-Plus Manager Server 地址")}
          />
        </label>
        <label className="theme-control-row theme-control-row--stacked">
          <span><strong>{ui("Manager 管理密钥")}</strong><small>{ui("用于访问 Manager 管理接口；不是本机 Codex 调用模型时使用的 API key。")}</small></span>
          <input
            className="cpa-usage-settings-input"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={ui("输入 Manager 管理密钥")}
            value={managementKey}
            onChange={(event) => { setManagementKey(event.target.value); setMessage(null) }}
            aria-label={ui("CPA Manager Server 管理密钥")}
          />
        </label>
        </>}
        <div className="cpa-usage-settings-actions">
          <button className="theme-notification-toggle theme-notification-toggle--enabled" type="button" disabled={busy} onClick={() => { void testConnection() }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {busy ? ui('正在测试连接…') : ui('测试连通性并保存')}
          </button>
          <button className="theme-notification-toggle" type="button" disabled={busy || (settings.source === 'codex-proxy' ? !settings.codexProxyBaseUrl && !settings.codexProxyApiKey : settings.source === 'new-api' ? !settings.newAPIBaseUrl && !settings.newAPIAccessToken && !settings.newAPIUserId : !settings.baseUrl && !settings.managementKey)} onClick={() => { save(settings.source === 'codex-proxy' ? { ...settings, codexProxyBaseUrl: '', codexProxyApiKey: '' } : settings.source === 'new-api' ? { ...settings, newAPIBaseUrl: '', newAPIAccessToken: '', newAPIUserId: '' } : { ...settings, baseUrl: '', managementKey: '' }); setMessage({ text: '已清除当前数据源连接。', error: false }) }}>
            <Trash2 size={14} />{ui("清除")}
          </button>
        </div>
        {message ? <p className={`cpa-usage-settings-message${message.error ? ' cpa-usage-settings-message--error' : ''}`} role={message.error ? 'alert' : 'status'}>{uiMessage(message.text)}</p> : null}
      </div>
      <p className="theme-settings-hint">{settings.source === 'codex-proxy'
        ? ui('地址和登录密码保存在当前浏览器，并经已配对的 Code Remote 后端读取 Codex Proxy 管理接口。密码不会放入 URL。历史用量依赖 Codex Proxy 已记录的快照。')
        : settings.source === 'new-api'
          ? ui('地址、访问令牌和用户 ID 保存在当前浏览器，并经已配对的 Code Remote 后端读取 New API 统计接口。令牌不会放入 URL；New API 需要开启数据导出。')
        : ui('地址和管理密钥保存在当前浏览器；密钥只通过 Authorization Bearer 请求头发送，不会放进 URL。Full Mode 才提供持久化历史统计；跨域时 Manager Server 需要允许当前网页来源。')}</p>
    </section>
  )
}
