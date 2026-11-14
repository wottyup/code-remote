import { ui, useUiLanguage } from '../lib/uiLanguage'
import { useState } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'

interface ClaudePermissionRequest {
  permissionId: string
  toolName: string
  command: string
  filePath: string
  cwd: string
  reason: string
}

interface Props {
  request: ClaudePermissionRequest
  onRespond: (allow: boolean) => Promise<boolean>
}

export function ClaudePermissionCard({ request, onRespond }: Props) {
  useUiLanguage()
  const [submitting, setSubmitting] = useState(false)
  const respond = async (allow: boolean) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onRespond(allow)
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="approval-card" role="alert">
    <div className="approval-card__heading"><AlertTriangle size={17} /><strong>{ui('Claude 需要你的批准')}</strong></div>
    <p>{request.reason || ui('Claude Code 请求执行一项需要批准的操作。')}</p>
    {request.toolName ? <small>{ui('工具：')}{request.toolName}</small> : null}
    {request.command ? <code>{request.command}</code> : null}
    {!request.command && request.filePath ? <code>{request.filePath}</code> : null}
    {request.cwd ? <small>{ui("目录：")}{request.cwd}</small> : null}
    <div className="approval-card__actions">
      <button type="button" disabled={submitting} onClick={() => respond(false)}><X size={14} />{ui("拒绝")}</button>
      <button className="approval-card__accept" type="button" disabled={submitting} onClick={() => respond(true)}><Check size={14} />{ui("允许")}</button>
    </div>
  </div>
}
