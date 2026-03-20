import { type CriteriaPillData, CRITERIA_LABELS } from './types';

interface CriteriaPillsProps {
  pills: CriteriaPillData[];
  selectedId: string | null;
  onSelect: (pill: CriteriaPillData) => void;
  onRemove: (id: string) => void;
}

function pillLabel(pill: CriteriaPillData): string {
  const label = CRITERIA_LABELS[pill.type];
  const v = pill.value;
  if (v.kind === 'text') return `${label}: ${v.text}`;
  if (v.kind === 'number') return `${label} ${v.op} ${v.value}`;
  return `${label}: ${v.values.join(', ')}`;
}

export function CriteriaPills({ pills, selectedId, onSelect, onRemove }: CriteriaPillsProps) {
  if (pills.length === 0) {
    return (
      <div className="filter-pills-area filter-pills-empty">
        No filters added yet
      </div>
    );
  }

  return (
    <div className="filter-pills-area">
      {pills.map(pill => (
        <span
          key={pill.id}
          className={`filter-pill${selectedId === pill.id ? ' filter-pill--selected' : ''}`}
          onClick={() => onSelect(pill)}
          title={pillLabel(pill)}
        >
          <span className="filter-pill-text">{pillLabel(pill)}</span>
          <button
            className="filter-pill-remove"
            onClick={e => { e.stopPropagation(); onRemove(pill.id); }}
            aria-label="Remove filter"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
