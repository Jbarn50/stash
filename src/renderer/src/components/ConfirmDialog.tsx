import { useEffect, useRef } from 'react'

/** A modal yes/no. Focus starts on Cancel, so a stray Enter never confirms a cleanup. Escape cancels. */
export default function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={confirmLabel}>
        <p>{message}</p>
        <div className="actions">
          <button ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
