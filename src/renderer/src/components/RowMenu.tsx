import { useEffect, useRef, useState } from 'react'

export interface RowMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

// A row's "⋮" overflow menu — the tucked-away home for Rename / Change
// hotkey / Clear hotkey / Delete, so a row's default state shows only its
// name, target, status, and toggle. Trigger and popover both live inside
// the row's own `position: relative` .cheat-row, so `.menu`'s `position:
// absolute` (theme.css) anchors to the row, not the page.
export default function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    // Auto-focus the first enabled item so arrow keys have somewhere to
    // start from immediately on open.
    const first = menuRef.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')
    first?.focus()
  }, [open])

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const focusable = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? []
    )
    if (focusable.length === 0) return
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? (current + 1) % focusable.length
        : (current - 1 + focusable.length) % focusable.length
    focusable[next]?.focus()
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        className="btn-icon row-reveal"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋮
      </button>
      {open && (
        <div className="menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {items.map((item, i) => (
            <button
              key={`${item.label}-${i}`}
              role="menuitem"
              className={`menu-item${item.danger ? ' menu-item-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
