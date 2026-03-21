import { useEffect, useReducer, useRef } from 'react';
import {
  addTrack, deleteTrack, getTrack, updateTrack, getTracks,
  addTag, editTag, deleteTag, getAllTags, assignTag, removeTagFromTrack, getTagsForTrack,
  addListen, getListensForTrack,
  addMeta, updateMeta, deleteMeta, getMetaForTrack,
  addTrackSource, removeTrackSource, getSourcesForTrack,
} from '../../db/tauriDb';
import type { SearchCriteria } from '../../db/tauriDb';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type TestStatus = 'pending' | 'running' | 'pass' | 'fail';

interface TestResult {
  name: string;
  status: TestStatus;
  message?: string;
  durationMs?: number;
}

interface TestGroup {
  name: string;
  results: TestResult[];
}

interface RunnerState {
  groups: TestGroup[];
  running: boolean;
  done: boolean;
}

type Action =
  | { type: 'START' }
  | { type: 'ADD_GROUP'; name: string }
  | { type: 'ADD_TEST'; groupIdx: number; name: string }
  | { type: 'UPDATE_TEST'; groupIdx: number; testIdx: number; result: Partial<TestResult> }
  | { type: 'DONE' };

function reducer(state: RunnerState, action: Action): RunnerState {
  switch (action.type) {
    case 'START':
      return { groups: [], running: true, done: false };
    case 'ADD_GROUP':
      return { ...state, groups: [...state.groups, { name: action.name, results: [] }] };
    case 'ADD_TEST': {
      const groups = state.groups.map((g, i) =>
        i === action.groupIdx
          ? { ...g, results: [...g.results, { name: action.name, status: 'pending' as TestStatus }] }
          : g,
      );
      return { ...state, groups };
    }
    case 'UPDATE_TEST': {
      const groups = state.groups.map((g, i) =>
        i === action.groupIdx
          ? {
              ...g,
              results: g.results.map((r, j) =>
                j === action.testIdx ? { ...r, ...action.result } : r,
              ),
            }
          : g,
      );
      return { ...state, groups };
    }
    case 'DONE':
      return { ...state, running: false, done: true };
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test runner helpers
// ─────────────────────────────────────────────────────────────────────────────
type Dispatcher = React.Dispatch<Action>;

async function runTest(
  dispatch: Dispatcher,
  groupIdx: number,
  testIdx: number,
  fn: () => Promise<void>,
): Promise<void> {
  dispatch({ type: 'UPDATE_TEST', groupIdx, testIdx, result: { status: 'running' } });
  const t0 = performance.now();
  try {
    await fn();
    dispatch({
      type: 'UPDATE_TEST',
      groupIdx,
      testIdx,
      result: { status: 'pass', durationMs: Math.round(performance.now() - t0) },
    });
  } catch (e) {
    dispatch({
      type: 'UPDATE_TEST',
      groupIdx,
      testIdx,
      result: {
        status: 'fail',
        message: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - t0),
      },
    });
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function tagCriteria(tagIds: number[]): SearchCriteria[] {
  return [{ column_name: 'tags', criteria: [{ mode: 'tags_in', tag_ids: tagIds }] }];
}

async function fullScan(tagIds: number[], limit = 100) {
  let cursor: number | null = null;
  const all = [];
  for (;;) {
    const page = await getTracks(cursor, tagCriteria(tagIds), limit);
    all.push(...page);
    if (page.length < limit) break;
    cursor = page[page.length - 1].id;
  }
  return all;
}

// Unique prefix per run so multiple runs don't collide in the DB
function runPrefix() {
  return `_test_${Date.now()}_`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

/** Track CRUD round-trip */
async function runTrackCrud(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = ['add_track', 'get_track', 'update_track', 'delete_track'];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  let trackId: number;

  await runTest(dispatch, gIdx, 0, async () => {
    trackId = await addTrack({
      artist: prefix + 'Artist',
      track_name: prefix + 'Song',
      length_seconds: 210,
      bitrate_kbps: 320,
      tempo_bpm: 128.0,
      addition_time: '2026-01-01',
      sources: [`https://example.com/${prefix}song.mp3`],
    });
    assert(typeof trackId === 'number' && trackId > 0, `trackId=${trackId}`);
  });

  await runTest(dispatch, gIdx, 1, async () => {
    const row = await getTrack(trackId!);
    assert(row.artist === prefix + 'Artist', `artist="${row.artist}"`);
    assert(row.track_name === prefix + 'Song', `track_name="${row.track_name}"`);
    assert(row.length_seconds === 210, `length=${row.length_seconds}`);
    assert(row.bitrate_kbps === 320, `bitrate=${row.bitrate_kbps}`);
  });

  await runTest(dispatch, gIdx, 2, async () => {
    await updateTrack(trackId!, { artist: prefix + 'ArtistEdited', track_name: null });
    const row = await getTrack(trackId!);
    assert(row.artist === prefix + 'ArtistEdited', `artist="${row.artist}"`);
    // track_name unchanged (null means "don't touch")
    assert(row.track_name === prefix + 'Song', `track_name="${row.track_name}"`);
  });

  await runTest(dispatch, gIdx, 3, async () => {
    await deleteTrack(trackId!);
    try {
      await getTrack(trackId!);
      throw new Error('Expected error after delete');
    } catch (e) {
      // Expected — row is gone
      if (e instanceof Error && e.message === 'Expected error after delete') throw e;
    }
  });
}

/** Tag CRUD + assign/remove round-trip */
async function runTagCrud(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = ['add_tag', 'edit_tag', 'assign_tag', 'get_tags_for_track', 'remove_tag', 'delete_tag'];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  let tagId: number;
  let trackId: number;

  await runTest(dispatch, gIdx, 0, async () => {
    tagId = await addTag(prefix + 'genre');
    assert(typeof tagId === 'number' && tagId > 0, `tagId=${tagId}`);
    const all = await getAllTags();
    assert(all.some(t => t.id === tagId), 'tag not in get_all_tags');
  });

  await runTest(dispatch, gIdx, 1, async () => {
    await editTag(tagId!, prefix + 'genre_edited');
    const all = await getAllTags();
    const t = all.find(x => x.id === tagId);
    assert(t?.tag_name === prefix + 'genre_edited', `tag_name="${t?.tag_name}"`);
  });

  // Need a track to test assign/remove
  trackId = await addTrack({
    artist: prefix + 'TagTestArtist', track_name: prefix + 'TagTestSong',
    length_seconds: null, bitrate_kbps: null, tempo_bpm: null,
    addition_time: '2026-01-01', sources: [`https://example.com/${prefix}t.mp3`],
  });

  await runTest(dispatch, gIdx, 2, async () => {
    await assignTag(trackId!, tagId!);
  });

  await runTest(dispatch, gIdx, 3, async () => {
    const tags = await getTagsForTrack(trackId!);
    assert(tags.some(t => t.id === tagId), 'tag not found for track');
  });

  await runTest(dispatch, gIdx, 4, async () => {
    await removeTagFromTrack(trackId!, tagId!);
    const tags = await getTagsForTrack(trackId!);
    assert(!tags.some(t => t.id === tagId), 'tag still present after remove');
  });

  await runTest(dispatch, gIdx, 5, async () => {
    await deleteTag(tagId!);
    const all = await getAllTags();
    assert(!all.some(t => t.id === tagId), 'tag still in get_all_tags after delete');
  });

  await deleteTrack(trackId!);
}

/** Listen history round-trip */
async function runListenHistory(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = ['add_listen', 'get_listens_for_track'];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  const trackId = await addTrack({
    artist: prefix + 'LA', track_name: prefix + 'LS',
    length_seconds: 180, bitrate_kbps: null, tempo_bpm: null,
    addition_time: '2026-01-01', sources: [`https://example.com/${prefix}l.mp3`],
  });

  let listenId: number;

  await runTest(dispatch, gIdx, 0, async () => {
    listenId = await addListen(trackId, 0, 180);
    assert(typeof listenId === 'number' && listenId > 0, `listenId=${listenId}`);
  });

  await runTest(dispatch, gIdx, 1, async () => {
    const listens = await getListensForTrack(trackId);
    assert(listens.some(l => l.id === listenId), 'listen not found');
    const l = listens.find(x => x.id === listenId)!;
    assert(l.listened_from === 0, `from=${l.listened_from}`);
    assert(l.listened_to === 180, `to=${l.listened_to}`);
  });

  await deleteTrack(trackId);
}

/** Track meta round-trip */
async function runMetaCrud(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = ['add_meta', 'update_meta', 'get_meta_for_track', 'delete_meta'];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  const trackId = await addTrack({
    artist: prefix + 'MA', track_name: prefix + 'MS',
    length_seconds: null, bitrate_kbps: null, tempo_bpm: null,
    addition_time: '2026-01-01', sources: [`https://example.com/${prefix}m.mp3`],
  });

  let metaId: number;

  await runTest(dispatch, gIdx, 0, async () => {
    metaId = await addMeta(trackId, 'album', prefix + 'AlbumA');
    assert(typeof metaId === 'number' && metaId > 0, `metaId=${metaId}`);
  });

  await runTest(dispatch, gIdx, 1, async () => {
    await updateMeta(metaId!, prefix + 'AlbumB');
    const rows = await getMetaForTrack(trackId);
    const m = rows.find(r => r.id === metaId);
    assert(m?.value === prefix + 'AlbumB', `value="${m?.value}"`);
  });

  await runTest(dispatch, gIdx, 2, async () => {
    const rows = await getMetaForTrack(trackId);
    assert(rows.some(r => r.key === 'album'), 'meta key not found');
  });

  await runTest(dispatch, gIdx, 3, async () => {
    await deleteMeta(metaId!);
    const rows = await getMetaForTrack(trackId);
    assert(!rows.some(r => r.id === metaId), 'meta still present after delete');
  });

  await deleteTrack(trackId);
}

/** Track sources round-trip */
async function runSourceCrud(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = ['add_track_source', 'get_sources_for_track', 'edit_track_source', 'remove_track_source'];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  const url1 = `https://example.com/${prefix}src1.mp3`;
  const url2 = `https://example.com/${prefix}src2.mp3`;

  const trackId = await addTrack({
    artist: prefix + 'SA', track_name: prefix + 'SS',
    length_seconds: null, bitrate_kbps: null, tempo_bpm: null,
    addition_time: '2026-01-01', sources: [url1],
  });

  await runTest(dispatch, gIdx, 0, async () => {
    const id = await addTrackSource(trackId, url2);
    assert(typeof id === 'number' && id > 0, `sourceId=${id}`);
  });

  await runTest(dispatch, gIdx, 1, async () => {
    const srcs = await getSourcesForTrack(trackId);
    assert(srcs.some(s => s.url === url1), 'url1 missing');
    assert(srcs.some(s => s.url === url2), 'url2 missing');
  });

  const { editTrackSource } = await import('../../db/tauriDb');
  const url3 = `https://example.com/${prefix}src3.mp3`;

  await runTest(dispatch, gIdx, 2, async () => {
    await editTrackSource(trackId, url2, url3);
    const srcs = await getSourcesForTrack(trackId);
    assert(!srcs.some(s => s.url === url2), 'url2 still present');
    assert(srcs.some(s => s.url === url3), 'url3 missing');
  });

  await runTest(dispatch, gIdx, 3, async () => {
    await removeTrackSource(trackId, url3);
    const srcs = await getSourcesForTrack(trackId);
    assert(!srcs.some(s => s.url === url3), 'url3 still present after remove');
  });

  await deleteTrack(trackId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag-filter query tests — mirrors testdb.rs perf_tag_lookup
//
// These tests seed a mini dataset (same layout as testdb.rs, but smaller
// to keep the test run fast) then run the same query scenarios.
// ─────────────────────────────────────────────────────────────────────────────

// Mini-seed constants — 1/10th of testdb.rs for speed
const SEED_N            = 500;
const SEED_TN           = 20;
const SEED_SHIFTS       = 5;
const SEED_BATCH        = SEED_N / SEED_TN;   // 25
const SEED_ARTIST_COUNT = Math.max(1, SEED_N / 1000); // 1

async function seedFilterDataset(prefix: string): Promise<{ trackIds: number[]; tagIds: number[] }> {
  // Insert tags
  const tagIds: number[] = [];
  for (let t = 1; t <= SEED_TN; t++) {
    tagIds.push(await addTag(`${prefix}tag_${t}`));
  }

  // Insert tracks
  const trackIds: number[] = [];
  for (let i = 1; i <= SEED_N; i++) {
    const artistIdx = ((i - 1) % SEED_ARTIST_COUNT) + 1;
    const id = await addTrack({
      artist: `${prefix}A_${artistIdx}`,
      track_name: `${prefix}${i}`,
      length_seconds: 100,
      bitrate_kbps: null,
      tempo_bpm: null,
      addition_time: '2026-01-01',
      sources: [`https://example.com/${prefix}track_${i}.mp3`],
    });
    trackIds.push(id);
  }

  // Assign tags (same layout as testdb.rs)
  for (let shift = 0; shift < SEED_SHIFTS; shift++) {
    for (let batch = 0; batch < SEED_TN; batch++) {
      const tagId = tagIds[(batch + shift) % SEED_TN];
      const trackStart = batch * SEED_BATCH;
      const trackEnd   = (batch + 1) * SEED_BATCH;
      for (let ti = trackStart; ti < trackEnd; ti++) {
        await assignTag(trackIds[ti], tagId);
      }
    }
  }

  return { trackIds, tagIds };
}

async function cleanFilterDataset(trackIds: number[], tagIds: number[]) {
  for (const id of trackIds) await deleteTrack(id);
  for (const id of tagIds)  await deleteTag(id);
}

async function runFilterQueries(dispatch: Dispatcher, gIdx: number, prefix: string) {
  const tests = [
    'seed dataset',
    'single-tag first page returns limit',
    'single-tag full scan returns correct total',
    'multi-tag [0,1] union count correct',
    'multi-tag [0,10,19] union count correct',
    'cursor pagination — no duplicates, covers full set',
    'cleanup dataset',
  ];
  tests.forEach(n => dispatch({ type: 'ADD_TEST', groupIdx: gIdx, name: n }));

  let trackIds: number[] = [];
  let tagIds: number[]   = [];

  await runTest(dispatch, gIdx, 0, async () => {
    ({ trackIds, tagIds } = await seedFilterDataset(prefix));
    assert(trackIds.length === SEED_N, `seeded ${trackIds.length} tracks`);
    assert(tagIds.length === SEED_TN, `seeded ${tagIds.length} tags`);
  });

  // Single-tag, first page
  await runTest(dispatch, gIdx, 1, async () => {
    // Each tag covers SEED_SHIFTS * SEED_BATCH = 125 tracks.
    // First page with limit=100 should be full.
    const rows = await getTracks(null, tagCriteria([tagIds[0]]), 100);
    assert(rows.length === 100, `expected 100, got ${rows.length}`);
  });

  // Single-tag, full scan
  await runTest(dispatch, gIdx, 2, async () => {
    const expected = SEED_SHIFTS * SEED_BATCH; // 125
    const rows = await fullScan([tagIds[0]]);
    assert(rows.length === expected, `expected ${expected}, got ${rows.length}`);
  });

  // Multi-tag [0, 1] union
  await runTest(dispatch, gIdx, 3, async () => {
    // tag0 batches: shifts × batch rows; tag1 overlaps by (SHIFTS-1) batches
    // union = (SHIFTS + 1) × BATCH = 150 tracks
    const expected = (SEED_SHIFTS + 1) * SEED_BATCH;
    const rows = await fullScan([tagIds[0], tagIds[1]]);
    assert(rows.length === expected, `expected ${expected}, got ${rows.length}`);
  });

  // Multi-tag [0, TN/2, TN-1] union
  await runTest(dispatch, gIdx, 4, async () => {
    // tag0 and tag(TN-1) overlap by (SHIFTS-1) batches; tag(TN/2) has no overlap with the other two
    // union = 3*SHIFTS*BATCH - (SHIFTS-1)*BATCH = (2*SHIFTS+1)*BATCH
    const expected = (2 * SEED_SHIFTS + 1) * SEED_BATCH;
    const rows = await fullScan([tagIds[0], tagIds[SEED_TN / 2], tagIds[SEED_TN - 1]]);
    assert(rows.length === expected, `expected ${expected}, got ${rows.length}`);
  });

  // Cursor pagination integrity
  await runTest(dispatch, gIdx, 5, async () => {
    const seen = new Set<number>();
    let cursor: number | null = null;
    let prevMax = -1;
    for (;;) {
      const page = await getTracks(cursor, tagCriteria([tagIds[0]]), 30);
      for (const row of page) {
        assert(!seen.has(row.id), `duplicate id ${row.id}`);
        assert(row.id > prevMax, `id ${row.id} <= prevMax ${prevMax}`);
        seen.add(row.id);
        prevMax = row.id;
      }
      if (page.length < 30) break;
      cursor = page[page.length - 1].id;
    }
    const expected = SEED_SHIFTS * SEED_BATCH;
    assert(seen.size === expected, `expected ${expected} unique, got ${seen.size}`);
  });

  // Cleanup
  await runTest(dispatch, gIdx, 6, async () => {
    await cleanFilterDataset(trackIds, tagIds);
  });
}



// ─────────────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────────────
async function runAll(dispatch: Dispatcher) {
  dispatch({ type: 'START' });
  const prefix = runPrefix();

  const suites: [string, (d: Dispatcher, g: number, p: string) => Promise<void>][] = [
    ['Track CRUD',          runTrackCrud],
    ['Tag CRUD',            runTagCrud],
    ['Listen history',      runListenHistory],
    ['Track meta CRUD',     runMetaCrud],
    ['Track source CRUD',   runSourceCrud],
    ['Tag filter queries',  runFilterQueries],
  ];

  for (let i = 0; i < suites.length; i++) {
    const [name, fn] = suites[i];
    dispatch({ type: 'ADD_GROUP', name });
    await fn(dispatch, i, prefix);
  }

  dispatch({ type: 'DONE' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
const statusColor: Record<TestStatus, string> = {
  pending: '#888',
  running: '#f0c040',
  pass:    '#4caf50',
  fail:    '#f44336',
};

const statusIcon: Record<TestStatus, string> = {
  pending: '○',
  running: '◐',
  pass:    '✓',
  fail:    '✗',
};




export default function TestRunner() {
  const [state, dispatch] = useReducer(reducer, { groups: [], running: false, done: false });
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    runAll(dispatch);
  }, []);

  const total  = state.groups.reduce((s, g) => s + g.results.length, 0);
  const passed = state.groups.reduce((s, g) => s + g.results.filter(r => r.status === 'pass').length, 0);
  const failed = state.groups.reduce((s, g) => s + g.results.filter(r => r.status === 'fail').length, 0);

  return (
    <div style={{ fontFamily: 'monospace', padding: 16, background: '#1e1e1e', color: '#d4d4d4', minHeight: '100vh' }}>
      <h2 style={{ margin: '0 0 8px', color: '#569cd6' }}>VampAgent · DB Integration Tests</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#808080' }}>
        Running against live Tauri backend · SQLite
      </p>

      {state.done && (
        <div style={{
          marginBottom: 16,
          padding: '8px 12px',
          borderRadius: 4,
          background: failed === 0 ? '#1e3a1e' : '#3a1e1e',
          color: failed === 0 ? '#4caf50' : '#f44336',
          fontWeight: 'bold',
        }}>
          {failed === 0
            ? `✓ All ${passed} tests passed`
            : `✗ ${failed} / ${total} tests failed`}
        </div>
      )}

      {state.groups.map((group, gi) => (
        <div key={gi} style={{ marginBottom: 16 }}>
          <div style={{ color: '#c586c0', fontWeight: 'bold', marginBottom: 4 }}>
            ▸ {group.name}
          </div>
          {group.results.map((r, ri) => (
            <div key={ri} style={{ paddingLeft: 16, lineHeight: 1.7 }}>
              <span style={{ color: statusColor[r.status] }}>
                {statusIcon[r.status]}
              </span>
              {' '}
              <span style={{ color: r.status === 'fail' ? '#f44336' : '#d4d4d4' }}>
                {r.name}
              </span>
              {r.durationMs != null && (
                <span style={{ color: '#555', fontSize: 11 }}> ({r.durationMs}ms)</span>
              )}
              {r.status === 'fail' && r.message && (
                <div style={{ paddingLeft: 16, color: '#f44336', fontSize: 12 }}>
                  {r.message}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {!state.running && !state.done && (
        <div style={{ color: '#808080' }}>Starting…</div>
      )}
      {state.running && !state.done && (
        <div style={{ color: '#f0c040', marginTop: 8 }}>Running…</div>
      )}
    </div>
  );
}
