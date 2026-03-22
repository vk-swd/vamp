import { SearchCriteria, TextIn, TagsIn, NumericBetween, NullCheck } from '../../db/tauriDb';
// // ── mock @tauri-apps/api/core BEFORE any import that depends on it ────────────
import {
  getTracks,
  TrackRow,
} from '../../db/tauriDb';
import { log } from '../../logger';

import { useState, useEffect, useRef } from 'react';


import { expectedRegularRetrievalRes, seedFilterDataset, tagName } from './helpers/seed';
import equal from 'fast-deep-equal';

const SEED_N = 500;
const PAGE_SIZE = 10;
const SEED_TAG_COUNT = 20;
const SEED_SHIFTS = 3;

log('Starting tauriDb tests...');

// describe('tauriDb — tag filter queries', () => {
log('Setting up test dataset...');

// beforeAll(async () => {
log('Seeding test dataset...');

log('ENDING tauriDb tests...');
const diffAt = (a: any, b: any) => {
  const strA = JSON.stringify(a);
  const strB = JSON.stringify(b);
  const i = [...strA].findIndex((ch, idx) => ch !== strB[idx]);
  return `Diff at index ${i}: ...${strA}... vs ...${strB}...`;
};

export default function TestPage() {
  log('rendering======...');
  const [logs, setLogs] = useState<string[]>([]);

  /**
   * Page through ALL results for `criteria`, verifying each page against the
   * expected values computed by `expectedRegularRetrievalRes`.
   *
   * 
   * #	Name	What it tests
1	regular	All 500 tracks, no filter
2	tags_in:[1]	Tracks with tag_1 (batches 0, 18, 19 → sparse IDs)
3	tags_in:[1,2,3]	Tracks with any of tag_1/2/3
4	artist_text_in	TextIn on artist (5 specific values)
5	bitrate_between_155_165	NumericBetween matching all 500 tracks
6	bitrate_between_200_300_empty	NumericBetween matching zero tracks (empty-page case)
7	tempo_not_null	NullCheck IS NOT NULL matching all 500 tracks
8	tags_in_page2	Spot-check: starts at cursor=11 (non-1) within a sparse set


   * Cursor advances to lastReturnedId+1 so sparse filtered result sets are
   * handled correctly (vs the old page+PAGE_SIZE approach which broke on gaps).
   * Stops when a page has fewer than PAGE_SIZE rows (last page).
   */
  const runPaginatedTest = (
    testName: string,
    criteria: SearchCriteria[] | undefined,
    compareCriteria?: (row: TrackRow, tags: string[], sources: string[]) => boolean,
  ): Promise<void> => {
    const go = (cursor: number): Promise<void> => {
      const expected = expectedRegularRetrievalRes(
        cursor, PAGE_SIZE, SEED_N, SEED_TAG_COUNT, SEED_SHIFTS, compareCriteria,
      );
      return getTracks(cursor, criteria ?? null, PAGE_SIZE).then(res => {
        if (!equal(res, expected)) {
          const error = `[${testName}] cursor=${cursor} FAILED! ${diffAt(res, expected)}`;
          log(error);
          throw new Error(error);
        }
        setLogs(prev => [...prev, `[${testName}] cursor=${cursor} ✓ (${res.length} rows)`]);
        if (res.length < PAGE_SIZE) {
          setLogs(prev => [...prev, `[${testName}] PASSED`]);
          return;
        }
        return go(res[res.length - 1].id + 1);
      });
    };
    return go(1);
  };

  const effectsCalled = useRef(false);
  const seedingLog = (msg: string) => {
    setLogs(prev => [...prev, msg]);
  };

  useEffect(() => {
    if (effectsCalled.current) return;
    effectsCalled.current = true;

    seedFilterDataset(SEED_N, SEED_TAG_COUNT, SEED_SHIFTS, seedingLog)
      // ── Test 1: regular pagination – no filter, all SEED_N tracks ────────
      .then(() => {
        log('Dataset seeded.');
        return runPaginatedTest('regular', undefined);
      })
      // ── Test 2: TagsIn – tracks carrying tag_id=1 ────────────────────────
      // Batch 0 (IDs 1-25): shift-0 tag = 1
      // Batch 18 (IDs 451-475): shift-2 tag = 1
      // Batch 19 (IDs 476-500): shift-1 tag = 1
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1] } as TagsIn],
        }];
        return runPaginatedTest(
          'tags_in:[1]',
          criteria,
          (_row, tags) => tags.includes(tagName(1)),
        );
      })
      // ── Test 3: TagsIn – tracks carrying any of tag_ids [1,2,3] ──────────
      // Batches 0-2 (IDs 1-75) and batches 18-19 (IDs 451-500).
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1, 2, 3] } as TagsIn],
        }];
        return runPaginatedTest(
          'tags_in:[1,2,3]',
          criteria,
          (_row, tags) => tags.some(t => [tagName(1), tagName(2), tagName(3)].includes(t)),
        );
      })
      // ── Test 4: artist TextIn – only a few specific artists ──────────────
      // artistIdx(i, 500) = i+1, so A_2 → track 1, A_3 → track 2, etc.
      .then(() => {
        const artists = ['A_2', 'A_3', 'A_4', 'A_5', 'A_6'];
        const criteria: SearchCriteria[] = [{
          columnName: 'artist',
          criteria: [{ mode: 'text_in', values: artists } as TextIn],
        }];
        return runPaginatedTest(
          'artist_text_in',
          criteria,
          (row) => artists.includes(row.artist),
        );
      })
      // ── Test 5: NumericBetween on bitrate_kbps (all seeded = 160) ────────
      // Range [155, 165] should match all 500 tracks.
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'bitrate_kbps',
          criteria: [{ mode: 'numeric_between', min: 155, max: 165 } as NumericBetween],
        }];
        return runPaginatedTest(
          'bitrate_between_155_165',
          criteria,
          (row) => row.bitrate_kbps !== null && row.bitrate_kbps >= 155 && row.bitrate_kbps <= 165,
        );
      })
      // ── Test 6: NumericBetween on bitrate_kbps (empty range) ─────────────
      // Range [200, 300] matches no seeded track – verifies empty-page case.
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'bitrate_kbps',
          criteria: [{ mode: 'numeric_between', min: 200, max: 300 } as NumericBetween],
        }];
        return runPaginatedTest(
          'bitrate_between_200_300_empty',
          criteria,
          (row) => row.bitrate_kbps !== null && row.bitrate_kbps >= 200 && row.bitrate_kbps <= 300,
        );
      })
      // ── Test 7: NullCheck IS NOT NULL on tempo_bpm ───────────────────────
      // All seeded tracks have tempo_bpm=120, so this should match all 500.
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'tempo_bpm',
          criteria: [{ mode: 'null_check', isNull: false } as NullCheck],
        }];
        return runPaginatedTest(
          'tempo_not_null',
          criteria,
          (row) => row.tempo_bpm !== null,
        );
      })
      // ── Test 8: TagsIn page-2 spot-check (non-1 start cursor) ────────────
      // Verifies that a mid-dataset cursor still produces correct results for
      // a sparse filtered set (tag_ids=[1], block 0 has IDs 1-25, so page 2
      // starts at cursor=11 and should return IDs 11-20).
      .then(() => {
        const criteria: SearchCriteria[] = [{
          columnName: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1] } as TagsIn],
        }];
        const cursor2 = 1 + PAGE_SIZE; // 11
        const expected = expectedRegularRetrievalRes(
          cursor2, PAGE_SIZE, SEED_N, SEED_TAG_COUNT, SEED_SHIFTS,
          (_row, tags) => tags.includes(tagName(1)),
        );
        return getTracks(cursor2, criteria, PAGE_SIZE).then(res => {
          if (!equal(res, expected)) {
            const error = `[tags_in_page2] cursor=${cursor2} FAILED! ${diffAt(res, expected)}`;
            log(error);
            throw new Error(error);
          }
          setLogs(prev => [...prev, `[tags_in_page2] cursor=${cursor2} ✓ PASSED`]);
        });
      })
      // The expectedRegularRetrievalRes spot-check above uses tagName(1) = 'tag_1'
      // as the filter string, matching what the seed function stores in `tags`.
      .then(() => {
        log('All tests completed successfully!');
        setLogs(prev => [...prev, '✅ All tests completed successfully!']);
      })
      .catch(err => {
        log(`Error: ${err}`);
        setLogs(prev => [...prev, `❌ ERROR: ${err}`]);
      });
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: '1rem' }}>
      <h2>Test Runner</h2>
      <div style={{ 
        background: '#111', 
        color: '#b9e595', 
        padding: '1rem', 
        height: '80vh', 
        overflowY: 'auto' 
      }}>
        <button onClick={() => {log(`hello`)}} style={{ marginBottom: '1rem' }}>Clear Logs</button>
        {logs.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
}