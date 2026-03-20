import { type CriteriaPillData, CRITERIA_LABELS } from './types';

interface CriteriaBrowserProps {
  pill: CriteriaPillData | null;
}

function describeValue(pill: CriteriaPillData): string {
  const label = CRITERIA_LABELS[pill.type];
  const v = pill.value;
  if (v.kind === 'text') {
    return `${label} fuzzy-matches "${v.text}"`;
  }
  if (v.kind === 'number') {
    const opLabel = v.op === '<' ? 'less than' : v.op === '>' ? 'greater than' : 'equal to';
    return `${label} is ${opLabel} ${v.value}`;
  }
  return `${label} is one of: ${v.values.join(', ')}`;
}

export function CriteriaBrowser({ pill }: CriteriaBrowserProps) {
  return (
    <div className="filter-criteria-browser">
      {pill ? (
        <span className="filter-criteria-browser-text">{describeValue(pill)}</span>
      ) : (
        <span className="filter-criteria-browser-hint">Click a filter pill to inspect it</span>
      )}
    </div>
  );
}
