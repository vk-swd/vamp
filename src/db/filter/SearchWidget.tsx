import { useState } from 'react';
import { type CriteriaPillData } from './types';
import { CriteriaInput } from './CriteriaInput';
import { Widget } from '../../ui/elements';

export function SearchWidget() {
  return (
    <Widget>
      <CriteriaInput/>
    </Widget>
  );
}
