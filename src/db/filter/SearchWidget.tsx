import { useState } from 'react';
import { type CriteriaPillData } from './types';
import { CriteriaInput } from './CriteriaInput';
import { CriteriaBrowser } from './CriteriaBrowser';
import './filter.css';

export function SearchWidget() {
  const [selectedPill, setSelectedPill] = useState<CriteriaPillData | null>(null);

  return (
    <div className="filter-widget">
      <CriteriaInput onSelectedChange={setSelectedPill} />
      <CriteriaBrowser pill={selectedPill} />
    </div>
  );
}
