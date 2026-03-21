/**
 * testDb.tsx
 *
 * TypeScript / vitest counterpart of src-tauri/src/db/testdb.rs.
 *
 * Strategy
 * ─────────
 * Because vitest runs in a Node / jsdom environment without a real Tauri
 * backend, `@tauri-apps/api/core`'s `invoke` is replaced by a fully
 * in-memory mock that re-implements the same query logic as SqliteRepository
 * in Rust.  The mock DB is seeded with the same dataset constants used in
 * the Rust perf test so that the expected row counts are identical.
 *
 * Seed layout (mirrors testdb.rs)
 * ───────────────────────────────
 *   N            = 5 000  total tracks
 *   TN           = 200    total tags
 *   SHIFTS       = 10     tag-assignment rounds
 *   BATCH        = 25     tracks per tag-batch  (N / TN)
 *   ARTIST_COUNT = 5      distinct artists       (N / 1000)
 *
 *   Every track gets exactly SHIFTS = 10 tags.
 *   Every tag covers exactly SHIFTS × BATCH = 250 distinct tracks.
 *   Total tag-assignment rows: N × SHIFTS = 50 000.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import type { MockInstance } from 'vitest';

// ── mock @tauri-apps/api/core BEFORE any import that depends on it ────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  getTracks,
  addTag,
  assignTag,
} from '../../db/tauriDb';
import type { TrackRow, Tag, SearchCriteria } from '../../db/tauriDb';

// ─────────────────────────────────────────────────────────────────────────────
// Dataset constants (must match testdb.rs)
// ─────────────────────────────────────────────────────────────────────────────
const N            = 5_000;
const TN           = 200;
const SHIFTS       = 10;
const BATCH        = N / TN;          // 25
const ARTIST_COUNT = N / 1_000;       //  5

// ─────────────────────────────────────────────────────────────────────────────
// In-memory database state
// ─────────────────────────────────────────────────────────────────────────────
interface InMemoryDb {
  tracks: Map<number, TrackRow>;
  tags: Map<number, Tag>;
  /** track_id → set of tag_ids assigned to that track */
  tagAssignments: Map<number, Set<number>>;
}

function createMockDb(): InMemoryDb {
  return {
    tracks: new Map(),
    tags: new Map(),
    tagAssignments: new Map(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding (mirrors the seed() function in testdb.rs)
// Direct population — no invoke() calls — same as how testdb.rs seeds via a
// raw sqlx pool bypassing the AppRepository trait.
// ─────────────────────────────────────────────────────────────────────────────
function seedMockDb(db: InMemoryDb): void {
  // ── tracks ────────────────────────────────────────────────────────────────
  for (let i = 1; i <= N; i++) {
    const artistIdx = ((i - 1) % ARTIST_COUNT) + 1;
    db.tracks.set(i, {
      id: i,
      artist: `A_${artistIdx}`,
      track_name: `${i}`,
      length_seconds: 100,
      bitrate_kbps: null,
      tempo_bpm: null,
      addition_time: '2026-01-01',
    });
  }

  // ── tags ──────────────────────────────────────────────────────────────────
  for (let t = 1; t <= TN; t++) {
    db.tags.set(t, { id: t, tag_name: `tag_${t}` });
  }

  // ── tag assignments ───────────────────────────────────────────────────────
  //
  // Layout (identical to testdb.rs):
  //   shift s, batch b  →  tag (b+s) % TN + 1  →  tracks b*BATCH+1 … (b+1)*BATCH
  //
  // Result: every track gets exactly SHIFTS tags; every tag covers
  // SHIFTS × BATCH = 250 distinct tracks.
  for (let shift = 0; shift < SHIFTS; shift++) {
    for (let batch = 0; batch < TN; batch++) {
      const tagId = ((batch + shift) % TN) + 1;
      const trackStart = batch * BATCH + 1;
      const trackEnd   = (batch + 1) * BATCH;
      for (let trackId = trackStart; trackId <= trackEnd; trackId++) {
        if (!db.tagAssignments.has(trackId)) {
          db.tagAssignments.set(trackId, new Set());
        }
        db.tagAssignments.get(trackId)!.add(tagId);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock invoke handler
// Implements the subset of Tauri commands exercised by the tests below.
// ─────────────────────────────────────────────────────────────────────────────
function mockGetTracks(
  db: InMemoryDb,
  cursor: number | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): TrackRow[] {
  const after = cursor ?? 0;

  // Start with all tracks after the cursor, sorted ascending by id
  let results: TrackRow[] = Array.from(db.tracks.values())
    .filter(t => t.id > after)
    .sort((a, b) => a.id - b.id);

  if (criteria) {
    for (const sc of criteria) {
      if (sc.column_name === 'tags') {
        for (const param of sc.criteria) {
          if (param.mode === 'tags_in') {
            const tagIds = new Set(param.tag_ids);
            results = results.filter(t => {
              const assignments = db.tagAssignments.get(t.id);
              if (!assignments) return false;
              for (const tid of tagIds) {
                if (assignments.has(tid)) return true;
              }
              return false;
            });
          }
        }
      } else {
        // Numeric / text filters on track columns
        for (const param of sc.criteria) {
          const col = sc.column_name as keyof TrackRow;
          switch (param.mode) {
            case 'numeric_comparison': {
              const { operator, value } = param;
              results = results.filter(t => {
                const v = t[col] as number | null;
                if (v == null) return false;
                switch (operator) {
                  case '<':  return v < value;
                  case '>':  return v > value;
                  case '=':  return v === value;
                  case '<=': return v <= value;
                  case '>=': return v >= value;
                  case '!=': return v !== value;
                }
              });
              break;
            }
            case 'numeric_between': {
              results = results.filter(t => {
                const v = t[col] as number | null;
                return v != null && v >= param.min && v <= param.max;
              });
              break;
            }
            case 'text_like': {
              // Convert SQL LIKE pattern to a JS regex
              const escaped = param.pattern
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/%/g, '.*')
                .replace(/_/g, '.');
              const rx = new RegExp(`^${escaped}$`, param.case_sensitive ? '' : 'i');
              results = results.filter(t => rx.test(String(t[col] ?? '')));
              break;
            }
            case 'text_in': {
              const set = new Set(param.values);
              results = results.filter(t => set.has(String(t[col] ?? '')));
              break;
            }
            case 'null_check': {
              results = results.filter(t =>
                param.is_null ? t[col] == null : t[col] != null,
              );
              break;
            }
          }
        }
      }
    }
  }

  return results.slice(0, limit);
}

function createInvokeHandler(db: InMemoryDb) {
  return (cmd: string, args?: Record<string, unknown>): unknown => {
    switch (cmd) {
      case 'get_tracks':
        return Promise.resolve(
          mockGetTracks(
            db,
            (args?.cursor as number | null) ?? null,
            (args?.criteria as SearchCriteria[] | null) ?? null,
            (args?.limit as number) ?? 100,
          ),
        );

      case 'add_tag': {
        const name = args?.name as string;
        const id   = db.tags.size + 1;
        db.tags.set(id, { id, tag_name: name });
        return Promise.resolve(id);
      }

      case 'assign_tag': {
        const trackId = args?.trackId as number;
        const tagId   = args?.tagId   as number;
        if (!db.tagAssignments.has(trackId)) {
          db.tagAssignments.set(trackId, new Set());
        }
        db.tagAssignments.get(trackId)!.add(tagId);
        return Promise.resolve();
      }

      default:
        return Promise.reject(new Error(`mock: unknown command "${cmd}"`));
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers (mirror first_page / full_scan in testdb.rs)
// ─────────────────────────────────────────────────────────────────────────────
function tagCriteria(tagIds: number[]): SearchCriteria[] {
  return [
    {
      column_name: 'tags',
      criteria: [{ mode: 'tags_in', tag_ids: tagIds }],
    },
  ];
}

async function firstPage(tagIds: number[], limit = 100): Promise<TrackRow[]> {
  return getTracks(null, tagCriteria(tagIds), limit);
}

async function fullScan(tagIds: number[], limit = 100): Promise<TrackRow[]> {
  let cursor: number | null = null;
  const all: TrackRow[] = [];
  for (;;) {
    const page = await getTracks(cursor, tagCriteria(tagIds), limit);
    all.push(...page);
    if (page.length < limit) break;
    cursor = page[page.length - 1].id;
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
const mockDb = createMockDb();

beforeAll(() => {
  (invoke as unknown as MockInstance).mockImplementation(
    createInvokeHandler(mockDb),
  );
  seedMockDb(mockDb);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe('tauriDb — tag filter queries (mirrors testdb.rs perf_tag_lookup)', () => {

  // ── Single-tag, first page ─────────────────────────────────────────────────
  describe('single-tag · first page (limit 100)', () => {
    // Every tag covers 250 tracks; first page should always fill up to the limit.
    const singleTagIds = [1, 25, 50, 75, 100, 125, 150, 175, 200];

    for (const tagId of singleTagIds) {
      it(`tag ${tagId} returns 100 rows`, async () => {
        const rows = await firstPage([tagId]);
        console.log(`  tag ${String(tagId).padStart(3)}  ${rows.length} rows`);
        expect(rows).toHaveLength(100);
      });
    }
  });

  // ── Single-tag, full paginated scan ───────────────────────────────────────
  describe('single-tag · full scan (limit 100)', () => {
    // Each tag covers exactly SHIFTS × BATCH = 250 tracks.
    const EXPECTED_PER_TAG = SHIFTS * BATCH; // 250

    for (const tagId of [1, 100, 200]) {
      it(`tag ${tagId} full scan returns ${EXPECTED_PER_TAG} rows`, async () => {
        const rows = await fullScan([tagId]);
        console.log(`  tag ${String(tagId).padStart(3)}  ${rows.length} total`);
        expect(rows).toHaveLength(EXPECTED_PER_TAG);
      });
    }
  });

  // ── Multi-tag, first page ─────────────────────────────────────────────────
  describe('multi-tag · first page (limit 100)', () => {
    // Union of tags covers > 100 tracks in all cases below, so the page is full.
    const cases: number[][] = [
      [1, 2],
      [1, 100, 200],
      [50, 51, 52, 53, 54],
    ];

    for (const tagIds of cases) {
      it(`tags [${tagIds}] returns 100 rows`, async () => {
        const rows = await firstPage(tagIds);
        console.log(`  tags [${tagIds}]  ${rows.length} rows`);
        expect(rows).toHaveLength(100);
      });
    }
  });

  // ── Multi-tag, full paginated scan ────────────────────────────────────────
  describe('multi-tag · full scan (limit 100)', () => {
    /**
     * Expected unique track counts, derived from the seeding formula:
     *
     *   Each tag t covers exactly the batches b where (b + s) % TN === t-1
     *   for some shift s ∈ [0, SHIFTS).  That gives the 10 batches:
     *     b = (t-1), (t-1+TN-1), (t-1+TN-2), … (mod TN)
     *
     *   For adjacent tags the overlap is SHIFTS-1 batches.
     *   For tags 100 apart the overlap is 0 batches (they share no batches).
     *   Use inclusion-exclusion to compute the union size in tracks.
     */

    // tags [1, 2]
    //   tag1 batches: {0, 199, 198, ..., 191}  (10 batches)
    //   tag2 batches: {1, 0, 199, ..., 192}    (10 batches)
    //   |tag1 ∩ tag2| = 9 batches  →  |union| = 11 batches = 275 tracks
    it('tags [1, 2] full scan', async () => {
      const rows = await fullScan([1, 2]);
      console.log(`  tags [1, 2]  ${rows.length} total`);
      expect(rows).toHaveLength(275);
    });

    // tags [1, 100, 200]
    //   tag1   batches: {0, 199, 198, 197, 196, 195, 194, 193, 192, 191}
    //   tag100 batches: {99, 98, 97, 96, 95, 94, 93, 92, 91, 90}
    //   tag200 batches: {199, 198, 197, 196, 195, 194, 193, 192, 191, 190}
    //   |1∩100|=0  |1∩200|=9  |100∩200|=0  |1∩100∩200|=0
    //   |union| = 10+10+10-0-9-0+0 = 21 batches = 525 tracks
    it('tags [1, 100, 200] full scan', async () => {
      const rows = await fullScan([1, 100, 200]);
      console.log(`  tags [1, 100, 200]  ${rows.length} total`);
      expect(rows).toHaveLength(525);
    });

    // tags [50, 51, 52, 53, 54]
    //   tag50 batches: {49..40}  tag51: {50..41}  tag52: {51..42}
    //   tag53: {52..43}          tag54: {53..44}
    //   Union of 5 consecutive-overlap sets = {40..53} = 14 batches = 350 tracks
    it('tags [50, 51, 52, 53, 54] full scan', async () => {
      const rows = await fullScan([50, 51, 52, 53, 54]);
      console.log(`  tags [50..54]  ${rows.length} total`);
      expect(rows).toHaveLength(350);
    });
  });

  // ── Pagination cursor integrity ────────────────────────────────────────────
  describe('cursor-based pagination', () => {
    it('pages are contiguous and non-overlapping', async () => {
      const tagId = 1;
      const limit = 30;
      let cursor: number | null = null;
      const seenIds = new Set<number>();
      let prevMaxId = -1;

      for (;;) {
        const page = await getTracks(cursor, tagCriteria([tagId]), limit);
        for (const row of page) {
          expect(seenIds.has(row.id)).toBe(false); // no duplicates
          expect(row.id).toBeGreaterThan(prevMaxId);
          seenIds.add(row.id);
          prevMaxId = row.id;
        }
        if (page.length < limit) break;
        cursor = page[page.length - 1].id;
      }

      expect(seenIds.size).toBe(SHIFTS * BATCH); // 250 unique tracks
    });
  });

  // ── addTag / assignTag API smoke test ─────────────────────────────────────
  describe('addTag and assignTag', () => {
    it('adds a new tag and assigns it via the abstraction layer', async () => {
      const tagId = await addTag('test_tag');
      expect(typeof tagId).toBe('number');

      // Assign the new tag to track 1
      await expect(assignTag(1, tagId)).resolves.toBeUndefined();

      // Verify via fullScan
      const rows = await fullScan([tagId]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some(r => r.id === 1)).toBe(true);
    });
  });
});
