import Select, { type StylesConfig } from 'react-select';
import { TagLookupContext } from '../LibraryWidget';
import { log } from '../../logger';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { TagLookupContext1 } from './CriteriaInput';


type Option = { value: string; label: string };

const selectStyles: StylesConfig<Option, true> = {
  control: (base, state) => ({
    ...base,
    background: 'var(--surface-2)',
    borderColor: state.isFocused ? 'var(--accent)' : 'var(--border)',
    borderWidth: '1.5px',
    borderRadius: 'var(--radius)',
    minHeight: '36px',
    boxShadow: state.isFocused ? '0 0 0 3px rgba(255, 0, 0, 0.15)' : 'none',
    '&:hover': { borderColor: 'var(--accent)' },
  }),
  menu: base => ({
    ...base,
    background: 'var(--surface-2)',
    border: '1.5px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
  }),
  option: (base, state) => ({
    ...base,
    background: state.isFocused ? 'var(--border)' : 'transparent',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: '0.88rem',
  }),
  multiValue: base => ({
    ...base,
    background: '#2e2e2e',
    borderRadius: '4px',
  }),
  multiValueLabel: base => ({
    ...base,
    color: 'var(--text)',
    fontSize: '0.82rem',
  }),
  multiValueRemove: base => ({
    ...base,
    color: 'var(--text-muted)',
    borderRadius: '0 4px 4px 0',
    ':hover': { background: 'var(--accent)', color: '#fff' },
  }),
  input: base => ({
    ...base,
    color: 'var(--text)',
    fontSize: '0.88rem',
  }),
  placeholder: base => ({
    ...base,
    color: 'var(--text-muted)',
    fontSize: '0.88rem',
  }),
  indicatorSeparator: () => ({ display: 'none' }),
  dropdownIndicator: base => ({
    ...base,
    color: 'var(--text-muted)',
    ':hover': { color: 'var(--text)' },
    padding: '0 6px',
  }),
  clearIndicator: base => ({
    ...base,
    color: 'var(--text-muted)',
    ':hover': { color: 'var(--text)' },
    padding: '0 4px',
  }),
  valueContainer: base => ({
    ...base,
    padding: '2px 8px',
    gap: '4px',
  }),
};


export function TagSelector() {
  const tagCtx = useContext(TagLookupContext);
  const topCtx = useContext(TagLookupContext1);
  const [listedTags, setListedTags] = useState<string[]>(["a", "b", "c"]);

  const [isLoading, setIsLoading] = useState(false);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (isLoading) {
            log(`This should be impossible - initial tag loading is blocked.`);
            return;
        }
        log(`loading tags ${isLoading}`)
        setIsLoading(true);
        log(`fetching all tags with empty pattern ${isLoading}`);
        tagCtx.getAllTags().then(tags => {
            log(`loaded tags ${tags.map(o => JSON.stringify(o))}`);
            setListedTags(tags.map(o => JSON.stringify(o)));
        }).catch(e => {
            log(`Error fetching tags: ${e}`);
        }).finally(() => {
            setIsLoading(false);
        });
        return () => {
            if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
        };
    }, []);

  const handleInputChange = useCallback((inputValue: string) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      tagCtx.getTags(inputValue).then(tags => {
        setListedTags(tags.map(o => JSON.stringify(o)));
      }).catch(e => {
        log(`Error fetching tags: ${e}`);
      });
    }, 300);
  }, [tagCtx]);

  return (
    <Select
      isMulti
      isDisabled={isLoading}
      options={listedTags.map(o => ({ value: o, label: o }))}
      value={topCtx.selectedTags.map(v => ({ value: v, label: v }))}
      onChange={(res) => { topCtx.setSelectedTags(res.map(o => o.value)); }}
      onInputChange={handleInputChange}
      placeholder={'Select...'}
      styles={selectStyles}
    />
  );}
