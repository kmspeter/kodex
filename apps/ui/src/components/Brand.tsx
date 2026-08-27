export function KodexMark({ compact = false }: { compact?: boolean }) {
  return <span className={`kodex-mark ${compact ? 'is-compact' : ''}`} aria-hidden="true"><span>K</span></span>;
}
