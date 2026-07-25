export default function AddressChip({
  label,
  pulsing
}: {
  label: string
  pulsing: boolean
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="address-chip">{label}</span>
      {pulsing && <span className="pulse-dot" />}
    </span>
  )
}
