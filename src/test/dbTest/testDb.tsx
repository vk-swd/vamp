import { SearchCriteria, TextIn, TagsIn, NumericBetween, NullCheck, TagsAll } from '../../db/tauriDb';
// // ── mock @tauri-apps/api/core BEFORE any import that depends on it ────────────
import {
  getTracks,
  TrackRow,
} from '../../db/tauriDb';
import { log } from '../../logger';

import { useState, useEffect, useRef } from 'react';


import { expectedRegularRetrievalRes as expectedResults, MIN_CURSOR, seedFilterDataset, SelectorForExpected, tagName } from './helpers/seed';
import equal from 'fast-deep-equal';

const SEED_N = 5000;
const PAGE_SIZE = 100;
const SEED_TAG_COUNT = 200
const TRACKS_WITH_SAME_TAGS = SEED_N / SEED_TAG_COUNT // 25 x 5 = 125 tags per track on average, with a specific pattern of distribution
const SEED_SHIFTS = 5;

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
  return `Diff at index ${i}: ...${a.length}... vs ...${b.length}...`;
};

export default function TestPage() {
  log('rendering======...');
  const [logs, setLogs] = useState<string[]>([]);

  /**
   * Page through ALL results for `criteria`, verifying each page against the
   * expected values computed by `expectedRegularRetrievalRes`.
   *
   */
  const runPaginatedTest = (
    testName: string,
    criteria: SearchCriteria[] | undefined,
    selectorForExpected?: SelectorForExpected,
  ): Promise<void> => {
    setLogs(prev => [...prev, `Start ${testName} test.`]);
    const runTestForPageAt = (cursor: number): Promise<void> => {
      const expected = expectedResults(
        cursor, PAGE_SIZE, SEED_N, SEED_TAG_COUNT, SEED_SHIFTS, selectorForExpected,
      );
      return getTracks(cursor, criteria ?? null, PAGE_SIZE).then(res => {
        if (!equal(res, expected)) {
          const error = `[${testName}] cursor=${cursor} FAILED! ${diffAt(res, expected)}`;
          log(error);
          throw new Error(error);
        }
        setLogs(prev => prev.slice(0, -1).concat(`[${testName}] cursor=${cursor} ✓ (${res.length} rows)`));
        if (res.length < PAGE_SIZE) {
          setLogs(prev => prev.slice(0, -1).concat(`[${testName}] PASSED`));
          return;
        }
        return runTestForPageAt(res[res.length - 1].id + 1);
      });
    };
    return runTestForPageAt(1);
  };

  /*  
    Constructs different tag combinations to verify that the tag filtering logic correctly identifies tracks with various tag configurations. 
    Also tast paginated output for each combination.
  */
  const testTagCombinations = (
    startTag: number, // for 5 tags it is the first tag
    size: number, // min number of tags to be assigned to tracks
    ) : Promise<void> => {
    log(`Testing tag combination with startTag=${startTag}, size=${size}`);
    if (size <= 0) {
      return testTagCombinations(startTag + 1, SEED_SHIFTS);
    }
    if (startTag > SEED_TAG_COUNT) {
      return Promise.resolve();
    }

    const lastTag = (startTag + size - MIN_CURSOR - 1) % SEED_TAG_COUNT + MIN_CURSOR;
    const firstTrackId = ((
      ((startTag - MIN_CURSOR) * TRACKS_WITH_SAME_TAGS
      -
      (SEED_SHIFTS - size) * TRACKS_WITH_SAME_TAGS)
    ) 
    + SEED_N) % SEED_N + MIN_CURSOR;
    const lastTrackId = (firstTrackId + (SEED_SHIFTS - size + 1) * TRACKS_WITH_SAME_TAGS - MIN_CURSOR - 1) % SEED_N + MIN_CURSOR;
    log(`Testing tags [${Array.from({ length: size }, (_, i) => tagName((startTag + i - MIN_CURSOR) % SEED_TAG_COUNT + MIN_CURSOR)).join(', ')}], expected track IDs between ${firstTrackId} and ${lastTrackId}`);
    
    
    const tagsToCheck: number[] = [startTag];
    for (let i = 1; i < size; i++) {
      tagsToCheck.push(((startTag + i - MIN_CURSOR) % SEED_TAG_COUNT) + MIN_CURSOR);
    }

    const overFlownTracks = lastTrackId < firstTrackId;
    let checkTracks = overFlownTracks ? (tId: number) => {
      return tId >= firstTrackId && tId <= SEED_N || tId <= lastTrackId && tId >= MIN_CURSOR;
    } : (tId: number) => tId >= firstTrackId && tId <= lastTrackId;
 
    return runPaginatedTest(`tags [${tagsToCheck.join(', ')}]`,
      [{
        column_name: 'tags',
        criteria: [{ mode: 'tags_all', tag_ids: tagsToCheck } as TagsAll],
    }], (row: TrackRow, tags: string[], sources: string[]) => {
        const tagChecks = tagsToCheck.map(t => tags.includes(tagName(t)));
        return tagChecks.every(Boolean) && checkTracks(row.id)
      })
    .then(() => {
      const newSize = size - 1;
      return testTagCombinations(startTag, newSize);
    })
  };
  const effectsCalled = useRef(false);
  const seedingLog = (msg: string, add: boolean) => {
    setLogs(prev => add ? [...prev, msg] : prev.slice(0, -1).concat(msg));
  };

  const criteria = useRef<SearchCriteria[]>([]);
  useEffect(() => {
    if (effectsCalled.current) return;
    effectsCalled.current = true;

    seedFilterDataset(SEED_N, SEED_TAG_COUNT, SEED_SHIFTS, seedingLog)
      // ── Test 1: regular pagination – no filter, all SEED_N tracks ────────
      .then(() => {
        return runPaginatedTest('regular', undefined);
      })
      // ── Test 2: TagsIn – tracks carrying tag_id=1 ────────────────────────
      // Batch 0 (IDs 1-25): shift-0 tag = 1
      // Batch 18 (IDs 451-475): shift-2 tag = 1
      // Batch 19 (IDs 476-500): shift-1 tag = 1
      .then(() => {
        criteria.current = [{
          column_name: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1] } as TagsIn],
        }];
        return runPaginatedTest(
          'tags_in:[1]',
          criteria.current,
          (_row, tags) => tags.includes(tagName(1)),
        );
      })
      // ── Test 3: TagsIn – tracks carrying any of tag_ids [1,2,3] ──────────
      // Batches 0-2 (IDs 1-75) and batches 18-19 (IDs 451-500).
      .then(() => {
        criteria.current = [{
          column_name: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1, 2, 3] } as TagsIn],
        }];
        return runPaginatedTest(
          'tags_in:[1,2,3]',
          criteria.current,
          (_row, tags) => tags.some(t => [tagName(1), tagName(2), tagName(3)].includes(t)),
        );
      })
      // ── Test 4: artist TextIn – only a few specific artists ──────────────
      // artistIdx(i, 500) = i+1, so A_2 → track 1, A_3 → track 2, etc.
      .then(() => {
        const artists = ['A_2', 'A_3', 'A_4', 'A_5', 'A_6'];
        criteria.current = [{
          column_name: 'artist',
          criteria: [{ mode: 'text_in', values: artists } as TextIn],
        }];
        return runPaginatedTest(
          'artist_text_in',
          criteria.current,
          (row) => artists.includes(row.artist),
        );
      })
      // ── Test 5: NumericBetween on bitrate_kbps (all seeded = 160) ────────
      // Range [155, 165] should match all 500 tracks.
      .then(() => {
        criteria.current = [{
          column_name: 'bitrate_kbps',
          criteria: [{ mode: 'numeric_between', min: 155, max: 165 } as NumericBetween],
        }];
        return runPaginatedTest(
          'bitrate_between_155_165',
          criteria.current,
          (row) => row.bitrate_kbps !== null && row.bitrate_kbps >= 155 && row.bitrate_kbps <= 165,
        );
      })
      // ── Test 6: NumericBetween on bitrate_kbps (empty range) ─────────────
      // Range [200, 300] matches no seeded track – verifies empty-page case.
      .then(() => {
        criteria.current = [{
          column_name: 'bitrate_kbps',
          criteria: [{ mode: 'numeric_between', min: 200, max: 300 } as NumericBetween],
        }];
        return runPaginatedTest(
          'bitrate_between_200_300_empty',
          criteria.current,
          (row) => row.bitrate_kbps !== null && row.bitrate_kbps >= 200 && row.bitrate_kbps <= 300,
        );
      })
      // ── Test 7: NullCheck IS NOT NULL on tempo_bpm ───────────────────────
      // All seeded tracks have tempo_bpm=120, so this should match all 500.
      .then(() => {
        criteria.current = [{
          column_name: 'tempo_bpm',
          criteria: [{ mode: 'null_check', is_null: false } as NullCheck],
        }];
        return runPaginatedTest(
          'tempo_not_null',
          criteria.current,
          (row) => row.tempo_bpm !== null,
        );
      })
      // ── Test 8: TagsIn page-2 spot-check (non-1 start cursor) ────────────
      // Verifies that a mid-dataset cursor still produces correct results for
      // a sparse filtered set (tag_ids=[1], block 0 has IDs 1-25, so page 2
      // starts at cursor=11 and should return IDs 11-20).
      .then(() => {
        criteria.current = [{
          column_name: 'tags',
          criteria: [{ mode: 'tags_in', tag_ids: [1] } as TagsIn],
        }];
        const cursor2 = 1 + PAGE_SIZE; // 11
        const expected = expectedResults(
          cursor2, PAGE_SIZE, SEED_N, SEED_TAG_COUNT, SEED_SHIFTS,
          (_row, tags) => tags.includes(tagName(1)),
        );
        return getTracks(cursor2, criteria.current, PAGE_SIZE).then(res => {
          if (!equal(res, expected)) {
            const error = `[tags_in_page2] cursor=${cursor2} FAILED! ${diffAt(res, expected)}`;
            log(error);
            throw new Error(error);
          }
          setLogs(prev => [...prev, `[tags_in_page2] cursor=${cursor2} ✓ PASSED`]);
        });
      })
      .then(() => testTagCombinations(MIN_CURSOR, SEED_SHIFTS))

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