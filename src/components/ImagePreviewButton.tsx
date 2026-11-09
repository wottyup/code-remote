import { ui, uiFormat, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ImagePreviewButtonProps {
  src: string
  name: string
  className?: string
}

export function ImagePreviewButton({ src, name, className = '' }: ImagePreviewButtonProps) {
  useUiLanguage()
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
  }, [open])

  return <>
    <button className={`image-preview-button ${className}`.trim()} type="button" title={uiFormat("查看图片：{0}", name)} aria-label={uiFormat("查看图片：{0}", name)} onClick={() => setOpen(true)}>
      <img src={src} alt={name} />
    </button>
    {open ? createPortal(
      <dialog ref={dialogRef} className="chat-image-dialog" aria-label={uiFormat("图片预览：{0}", name)} onClose={() => setOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
        <div className="chat-image-dialog__header">
          <span title={name}>{name}</span>
          <button type="button" aria-label={ui("关闭图片预览")} onClick={() => dialogRef.current?.close()}><X size={20} /></button>
        </div>
        <div className="chat-image-dialog__body"><img src={src} alt={name} /></div>
      </dialog>, document.body,
    ) : null}
  </>
}
