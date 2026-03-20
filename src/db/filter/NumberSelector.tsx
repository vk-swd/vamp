import type { ComparisonOp } from './types';

interface NumberSelectorProps {
  op: ComparisonOp;
  value: number;
  onChange: (op: ComparisonOp, value: number) => void;
}

export function NumberSelector({ op, value, onChange }: NumberSelectorProps) {
  return (
    <div className="filter-number-selector">
      <select
        className="filter-select filter-op-select"
        value={op}
        onChange={e => onChange(e.target.value as ComparisonOp, value)}
      >
        <option value="<">&lt;</option>
        <option value=">">&gt;</option>
        <option value="==">==</option>
      </select>
      <input
        className="filter-input filter-number-input"
        type="number"
        value={value}
        onChange={e => onChange(op, Number(e.target.value))}
      />
    </div>
  );
}
