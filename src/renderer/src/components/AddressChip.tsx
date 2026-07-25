export default function AddressChip({
  baseOffset,
  pulsing
}: {
  baseOffset: string
  pulsing: boolean
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="address-chip">{baseOffset}</span>
      {pulsing && <span className="pulse-dot" />}
    </span>
  )
}
