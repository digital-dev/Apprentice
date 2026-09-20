import { placeholder, useArt } from '../gameArt'

// A game's portrait cover: the art Steam has cached, or a stable coloured
// placeholder with the game's initials while it loads or when there is none.
export default function GameCover({
  appId,
  name,
  className = ''
}: {
  appId: string
  name: string
  className?: string
}) {
  const art = useArt(appId, 'portrait')
  if (art) {
    return (
      <div
        className={`cover ${className}`}
        style={{ backgroundImage: `url(${art})` }}
        role="img"
        aria-label={`${name} cover`}
      />
    )
  }
  const p = placeholder(appId, name)
  return (
    <div className={`cover cover-placeholder ${className}`} style={{ background: p.background }} aria-hidden="true">
      <span>{p.initials}</span>
    </div>
  )
}
