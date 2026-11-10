import { Check, Download, LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import type { DesktopUpdateStatus, WebDeviceManagerState } from '../lib/webDeviceManager'

type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing'

function formatPackageSize(bytes: number, language: 'zh-CN' | 'en'): string {
  const locale = language === 'en' ? 'en-US' : 'zh-CN'
  const unit = bytes >= 1024 * 1024 ? 'MB' : 'KB'
  const value = bytes / (unit === 'MB' ? 1024 * 1024 : 1024)
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`
}

function updateError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback
}

export function DesktopUpdateCard({ manager }: { manager: WebDeviceManagerState }) {
  const language = useUiLanguage()
  const bridge = typeof window === 'undefined' ? undefined : window.CodeRemoteDesktop
  const supported = manager.mode === 'desktop'
    && typeof bridge?.checkDesktopUpdate === 'function'
    && typeof bridge.downloadDesktopUpdate === 'function'
    && typeof bridge.installDesktopUpdate === 'function'
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (manager.mode !== 'desktop') return null

  const currentVersion = status?.currentVersion || bridge?.currentVersion || '—'
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing'

  function statusText(): string {
    if (!supported) return ui('当前桌面端版本不支持应用内更新，请安装新版后再使用。')
    if (phase === 'checking') return ui('正在从当前设备检查桌面安装包…')
    if (phase === 'downloading') return ui('正在下载并校验安装包，请保持当前设备在线…')
    if (phase === 'installing') return ui('正在启动安装程序，Code Remote 即将退出。')
    if (phase === 'latest') return uiFormat('已是最新桌面版本（{0}）。', currentVersion)
    if (phase === 'available' && status) {
      return uiFormat('发现桌面版 {0}，安装包大小 {1}。', status.latestVersion, formatPackageSize(status.sizeBytes, language))
    }
    if (phase === 'downloaded' && status) return uiFormat('桌面版 {0} 已下载并通过 SHA-256 校验。', status.latestVersion)
    return ui('从当前连接的设备检查、下载并覆盖安装新版。')
  }

  function actionLabel(): string {
    if (phase === 'checking') return ui('正在检查…')
    if (phase === 'downloading') return ui('正在下载…')
    if (phase === 'installing') return ui('正在启动…')
    if (phase === 'available') return ui('下载更新')
    if (phase === 'downloaded') return ui('安装更新')
    if (phase === 'latest') return ui('再次检查')
    return ui('检查更新')
  }

  async function installUpdate(version: string) {
    if (!bridge || !supported) return
    const confirmed = window.confirm(uiFormat(
      '桌面版 {0} 已下载并校验完成。现在关闭 Code Remote 并开始覆盖安装吗？',
      version,
    ))
    if (!confirmed) {
      setPhase('downloaded')
      return
    }
    setError(null)
    setPhase('installing')
    try {
      await bridge.installDesktopUpdate()
    } catch (reason) {
      setPhase('downloaded')
      setError(updateError(reason, '无法启动桌面更新安装程序。'))
    }
  }

  async function checkUpdate() {
    if (!bridge || !supported) return
    setError(null)
    setPhase('checking')
    try {
      const next = await bridge.checkDesktopUpdate()
      setStatus(next)
      setPhase(next.available ? 'available' : 'latest')
    } catch (reason) {
      setPhase('idle')
      setError(updateError(reason, '检查桌面更新失败。'))
    }
  }

  async function downloadUpdate() {
    if (!bridge || !supported || !status) return
    setError(null)
    setPhase('downloading')
    try {
      const downloaded = await bridge.downloadDesktopUpdate()
      const nextStatus = { ...status, latestVersion: downloaded.version, sizeBytes: downloaded.sizeBytes }
      setStatus(nextStatus)
      setPhase('downloaded')
      await installUpdate(downloaded.version)
    } catch (reason) {
      setPhase('available')
      setError(updateError(reason, '下载桌面安装包失败。'))
    }
  }

  function performAction() {
    if (phase === 'available') {
      void downloadUpdate()
    } else if (phase === 'downloaded' && status) {
      void installUpdate(status.latestVersion)
    } else {
      void checkUpdate()
    }
  }

  const ActionIcon = phase === 'available' || phase === 'downloaded'
    ? Download
    : phase === 'latest'
      ? Check
      : RefreshCw

  return (
    <div className="desktop-update" aria-label={ui('Windows 桌面更新')}>
      <div className="desktop-update__copy">
        <div className="desktop-update__title">
          <strong>{ui('Windows 桌面版')}</strong>
          <span>{currentVersion === '—' ? currentVersion : `v${currentVersion}`}</span>
        </div>
        <p role="status" aria-live="polite">{statusText()}</p>
      </div>
      <button className="desktop-update__action" type="button" disabled={!supported || busy} aria-busy={busy} onClick={performAction}>
        {busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <ActionIcon size={15} aria-hidden="true" />}
        {actionLabel()}
      </button>
      {error ? <p className="desktop-update__error" role="alert">{uiMessage(error)}</p> : null}
    </div>
  )
}
