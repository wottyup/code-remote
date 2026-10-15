import type { CSSProperties } from 'react'
import { workspaceFileIcon, workspaceFileType } from '../lib/workspaceFileTypes'

interface WorkspaceFileTypeIconProps {
  path: string
  size?: number
}

export function WorkspaceFileTypeIcon({ path, size = 16 }: WorkspaceFileTypeIconProps) {
  const fileType = workspaceFileType(path)
  const icon = workspaceFileIcon(path)
  return (
    <svg
      className="workspace-file-type-icon"
      style={{ '--workspace-file-icon-size': `${size}px` } as CSSProperties}
      viewBox="0 0 32 32"
      focusable="false"
      aria-hidden="true"
    >
      <title>{fileType.language ?? fileType.label}</title>
      <use href={`/workspace-file-icons.svg#${icon}`} />
    </svg>
  )
}
