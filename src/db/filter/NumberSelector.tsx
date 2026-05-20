import type { ComparisonOp } from './types';
import { LineEdit, Selector } from '../../ui/elements';

interface NumberSelectorProps {
  op: ComparisonOp;
  value: number;
  onChange: (op: ComparisonOp, value: number) => void;
}

const OP_OPTIONS = [
  { value: '<',  label: '<' },
  { value: '>',  label: '>' },
  { value: '==', label: '==' },
];

export function NumberSelector({ op, value, onChange }: NumberSelectorProps) {
  return (
    <div className="ctrl-row">
      <Selector
        options={OP_OPTIONS}
        value={op}
        onChange={val => onChange(val as ComparisonOp, value)}
      />
      <LineEdit
        numeric
        value={String(value)}
        onChange={val => onChange(op, Number(val))}
        fieldStyle={{ flex: 1 }}
      />
    </div>
  );
}
