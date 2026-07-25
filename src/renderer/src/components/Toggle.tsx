export default function Toggle({
  enabled,
  onChange,
  disabled
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      style={{
        background: enabled ? 'var(--active)' : 'rgba(255,255,255,0.08)',
        border: 'none',
        borderRadius: 999,
        width: 40,
        height: 22,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
      aria-pressed={enabled}
    />
  )
}
