import { Button, Widget } from '../../ui/elements';
import { type CriteriaPillData, CRITERIA_LABELS } from './types';
import './filter.css';

interface CriteriaPillsProps {
  pills: CriteriaPillData[];
  selectedId: string | null;
  onSelect: (pill: CriteriaPillData) => void;
  onRemove: (id: string) => void;
}

function pillLabel(pill: CriteriaPillData): string {
  const label = CRITERIA_LABELS[pill.type];
  const v = pill.value;
  if (v.kind === 'text') return `${label}: ${v.text.length < 20 ? v.text : v.text.slice(0,20) + "..."}`;
  if (v.kind === 'number') return `${label} ${v.op} ${v.value}`;
  return `${label}: ${v.values.join(', ')}`;
}

export function CriteriaPills({ pills, selectedId, onSelect, onRemove }: CriteriaPillsProps) {
  if (pills.length === 0) {
    return (
      <Widget>
        No filters added yet
      </Widget>
    );
  }

  return (
    <Widget>
      {pills.map(pill => (
        <span className="pill-row">
          <Button
            key={pill.id}
            size="sm"
            className="pill-label"
            onClick={() => onSelect(pill)}>
              {pillLabel(pill)}
          </Button>
          <Button
            size="sm"
            onClick={e => { e.stopPropagation(); onRemove(pill.id); }}
            aria-label="Remove filter"
          >
            ×
          </Button>

        </span>
      ))}
    </Widget>
  );
}
