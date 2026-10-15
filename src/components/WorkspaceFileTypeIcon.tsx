import type { CSSProperties } from 'react'
import { workspaceFileType } from '../lib/workspaceFileTypes'

interface WorkspaceFileTypeIconProps {
  path: string
  size?: number
}

export function WorkspaceFileTypeIcon({ path, size = 16 }: WorkspaceFileTypeIconProps) {
  const fileType = workspaceFileType(path)
  return (
    <span
      className={`workspace-file-type-icon workspace-file-type-icon--${fileType.tone}`}
      style={{ '--workspace-file-icon-size': `${size}px` } as CSSProperties}
      title={fileType.label}
      aria-hidden="true"
    >
      <span>{fileType.label}</span>
    </span>
  )
}
