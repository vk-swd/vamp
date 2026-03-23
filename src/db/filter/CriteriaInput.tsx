import React, { createContext, useMemo, useState } from 'react';
import {
  type CriteriaType,
  type CriteriaValue,
  type ComparisonOp,
  type CriteriaPillData,
  CRITERIA_LABELS,
  TEXT_CRITERIA,
  NUMBER_CRITERIA,
} from './types';
import { NumberSelector } from './NumberSelector';
import { TagSelector } from './TagSelector';
import { CriteriaPills } from './CriteriaPills';
import { Button } from '../../ui/elements';

// ── Context consumed by TagSelector ───────────────────────────────────────
interface TagLookupContext1Value {
  selectedTags: string[];
  setSelectedTags: (tags: string[]) => void;
}
export const TagLookupContext1 = createContext<TagLookupContext1Value>({
  selectedTags: [],
  setSelectedTags: () => {},
});

// ── Unified per-criteria value state ──────────────────────────────────────
export type CriteriaState = {
  text?: string;
  valuenum?: number;
  op?: ComparisonOp;
  options?: string[];
};

// numeric state | multiselect | single select


type CriteriaStateMap = Record<CriteriaType, CriteriaState>;

const ALL_CRITERIA = Object.keys(CRITERIA_LABELS) as CriteriaType[];

const INITIAL_STATE_MAP = Object.fromEntries(
  ALL_CRITERIA.map(t => [
    t,
    NUMBER_CRITERIA.includes(t) ? { op: '>' as ComparisonOp, valuenum: 0 } : {},
  ])
) as CriteriaStateMap;

// ── State → CriteriaValue (pure) ────────────────────────────────────────
function stateToValue(type: CriteriaType, state: CriteriaState): CriteriaValue | null {
  if (TEXT_CRITERIA.includes(type)) {
    if (!state.text?.trim()) return null;
    return { kind: 'text', text: state.text.trim() };
  }
  if (NUMBER_CRITERIA.includes(type)) {
    return { kind: 'number', op: state.op ?? '>', value: state.valuenum ?? 0 };
  }
  if (!state.options?.length) return null;
  return { kind: 'multi', values: state.options };
}

// ── Per-type widget components ─────────────────────────────────────────────
interface WidgetProps {
  type: CriteriaType;
  state: CriteriaState;
  update: (patch: Partial<CriteriaState>) => void;
  onCommit: () => void;
}

function TextWidget({ type, state, update, onCommit }: WidgetProps) {
  return (
    <input
      className="filter-input"
      type="text"
      value={state.text ?? ''}
      placeholder={`Search ${CRITERIA_LABELS[type]}…`}
      onChange={e => update({ text: e.target.value })}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
    />
  );
}

function NumberWidget({ state, update }: WidgetProps) {
  return (
    <NumberSelector
      op={state.op ?? '>'}
      value={state.valuenum ?? 0}
      onChange={(op, val) => update({ op, valuenum: val })}
    />
  );
}

function MultiWidget({ state, update }: WidgetProps) {
  return (
    <TagLookupContext1.Provider
      value={{
        selectedTags: state.options ?? [],
        setSelectedTags: tags => update({ options: tags }),
      }}
    >
      <TagSelector />
    </TagLookupContext1.Provider>
  );
}

// ── Widget factory map: one entry per CriteriaType ─────────────────────────
const CRITERIA_WIDGET: Record<CriteriaType, (p: WidgetProps) => React.ReactElement> = {
  artist:        p => <TextWidget   {...p} />,
  track:         p => <TextWidget   {...p} />,
  duration:      p => <NumberWidget {...p} />,
  tempo:         p => <NumberWidget {...p} />,
  bitrate:       p => <NumberWidget {...p} />,
  totalListened: p => <NumberWidget {...p} />,
  sources:       p => <MultiWidget  {...p} />,
  tags:          p => <MultiWidget  {...p} />,
};


let _nextId = 1;

export function CriteriaInput() {
  const [type, setType] = useState<CriteriaType>('artist');
  const [stateMap, setStateMap] = useState<CriteriaStateMap>(INITIAL_STATE_MAP);
  // activePills: type → stable pill ID (one pill per criteria type)
  const [activePills, setActivePills] = useState<Map<CriteriaType, string>>(new Map());
  const [pillOrder, setPillOrder] = useState<CriteriaType[]>([]);
  const [selectedType, setSelectedType] = useState<CriteriaType | null>(null);

  const update = (patch: Partial<CriteriaState>) =>
    setStateMap(prev => ({ ...prev, [type]: { ...prev[type], ...patch } }));

  const handleAdd = () => {
    // get all input values
    // assign thies value to the search state map
    // rerender pills based on the result
    if (!stateToValue(type, stateMap[type])) return;
    if (!activePills.has(type)) {
      setActivePills(prev => new Map(prev).set(type, String(_nextId++)));
      setPillOrder(prev => [...prev, type]);
    }
    // already active → stateMap change is reflected automatically via useMemo below
  };

  const pills: CriteriaPillData[] = useMemo(
    () =>
      pillOrder
        .filter(t => activePills.has(t))
        .flatMap(t => {
          const value = stateToValue(t, stateMap[t]);
          return value ? [{ id: activePills.get(t)!, type: t, value }] : [];
        }),
    [stateMap, activePills, pillOrder],
  );

  const handleRemove = (id: string) => {
    const entry = [...activePills.entries()].find(([, pid]) => pid === id);
    if (!entry) return;
    const [t] = entry;
    setActivePills(prev => { const n = new Map(prev); n.delete(t); return n; });
    setPillOrder(prev => prev.filter(x => x !== t));
    if (selectedType === t) { setSelectedType(null); }
  };

  const handleSelectPill = (pill: CriteriaPillData) => {
    setType(pill.type);
    setSelectedType(pill.type);
  };

  return (
    <div>
      <div className="ctrl-row">
        <select
          value={type}
          onChange={e => { setType(e.target.value as CriteriaType); setSelectedType(null); }}
        >
          {ALL_CRITERIA.map(k => (
            <option key={k} value={k}>{CRITERIA_LABELS[k]}</option>
          ))}
        </select>

        <div className="filter-value-control">
          {CRITERIA_WIDGET[type]({ type, state: stateMap[type], update, onCommit: handleAdd })}
        </div>

        <Button  onClick={handleAdd}>
          Add
        </Button>
      </div>

      <CriteriaPills
        pills={pills}
        selectedId={selectedType ? (activePills.get(selectedType) ?? null) : null}
        onSelect={handleSelectPill}
        onRemove={handleRemove}
      />
    </div>
  );
}
