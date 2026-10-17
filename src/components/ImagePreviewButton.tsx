import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ImagePreviewButtonProps {
  src: string
  name: string
  className?: string
}

export function ImagePreviewButton({ src, name, className = '' }: ImagePreviewButtonProps) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
  }, [open])

  return <>
    <button className={`image-preview-button ${className}`.trim()} type="button" title={`查看图片：${name}`} aria-label={`查看图片：${name}`} onClick={() => setOpen(true)}>
      <img src={src} alt={name} />
    </button>
    {open ? createPortal(
      <dialog ref={dialogRef} className="chat-image-dialog" aria-label={`图片预览：${name}`} onClose={() => setOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
        <div className="chat-image-dialog__header">
          <span title={name}>{name}</span>
          <button type="button" aria-label="关闭图片预览" onClick={() => dialogRef.current?.close()}><X size={20} /></button>
        </div>
        <div className="chat-image-dialog__body"><img src={src} alt={name} /></div>
      </dialog>, document.body,
    ) : null}
  </>
}
