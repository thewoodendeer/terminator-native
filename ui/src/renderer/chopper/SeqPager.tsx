// SEQ PAGER — the one pattern picker every sequencer shares (chop sequencer,
// drum sequencer, bass piano roll): ◀ SEQ n/N ▶ · + new · ⧉ duplicate · ✕
// delete. Same buttons, same order, same look everywhere; the host wires the
// callbacks to its own engine. Styled by .sqp-* in terminator.css (palette-
// first tokens, so the mobile skins and desktop themes both colour it).
interface Props {
  index: number;            // 0-based current
  count: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  max?: number;             // disable + / ⧉ at this many
  label?: string;           // defaults to "SEQ"
  /** What "delete" does when only one pattern is left (tooltip copy). */
  lastDeleteHint?: string;
  compact?: boolean;
}

export function SeqPager({ index, count, onSelect, onAdd, onDuplicate, onDelete, max, label = 'SEQ', lastDeleteHint, compact }: Props) {
  const atMax = typeof max === 'number' && count >= max;
  return (
    <div className={`sqp${compact ? ' compact' : ''}`} role="group" aria-label={`${label} patterns`}>
      <button className="sqp-btn" disabled={index <= 0} onClick={() => onSelect(index - 1)} title="Previous pattern">◀</button>
      <span className="sqp-label" title={`Pattern ${index + 1} of ${count}`}>{label} {index + 1}<small>/{count}</small></span>
      <button className="sqp-btn" disabled={index >= count - 1} onClick={() => onSelect(index + 1)} title="Next pattern">▶</button>
      <span className="sqp-gap" />
      <button className="sqp-btn sqp-add" disabled={atMax} onClick={onAdd} title="New empty pattern">+</button>
      <button className="sqp-btn sqp-dup" disabled={atMax} onClick={onDuplicate} title="Duplicate this pattern">⧉</button>
      <button className="sqp-btn sqp-del" onClick={onDelete}
        title={count > 1 ? 'Delete this pattern' : (lastDeleteHint ?? 'Clear this pattern (the last one can’t be deleted)')}>✕</button>
    </div>
  );
}
