export default function Toggle({
  enabled,
  onChange
}: {
  enabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      style={{
        background: enabled ? 'var(--active)' : 'rgba(255,255,255,0.08)',
        border: 'none',
        borderRadius: 999,
        width: 40,
        height: 22,
        cursor: 'pointer'
      }}
      aria-pressed={enabled}
    />
  )
}
