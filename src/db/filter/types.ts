export type CriteriaType =
  | 'artist'
  | 'track'
  | 'duration'
  | 'tempo'
  | 'bitrate'
  | 'totalListened'
  | 'sources'
  | 'tags';

export type ComparisonOp = '<' | '>' | '==';

export type CriteriaValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; op: ComparisonOp; value: number }
  | { kind: 'multi'; values: string[] };

export interface CriteriaPillData {
  id: string;
  type: CriteriaType;
  value: CriteriaValue;
}

export const CRITERIA_LABELS: Record<CriteriaType, string> = {
  artist: 'Artist',
  track: 'Track Name',
  duration: 'Duration',
  tempo: 'Tempo',
  bitrate: 'Bitrate',
  totalListened: 'Total Listened',
  sources: 'Sources',
  tags: 'Tags',
};

export const TEXT_CRITERIA: CriteriaType[] = ['artist', 'track'];
export const NUMBER_CRITERIA: CriteriaType[] = ['duration', 'tempo', 'bitrate', 'totalListened'];
export const MULTI_CRITERIA: CriteriaType[] = ['sources', 'tags'];
