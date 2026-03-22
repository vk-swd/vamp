import { addTag, addTracks, assignTags, TagAssignment, TrackRow } from "../../../db/tauriDb";


function tracksPerArtist(SEED_N: number) {
    return Math.max(1, SEED_N / 1000); // 1
}
function artistIdx(i: number, SEED_N: number) {
    return Math.floor(i / tracksPerArtist(SEED_N)) + 1;
}
function calcTag(i: number, shift: number, SEED_N: number, SEED_TAG_COUNT: number) {
    const SEED_BATCH = SEED_N / SEED_TAG_COUNT; // 25
    return ((Math.floor(i / SEED_BATCH) + shift) % SEED_TAG_COUNT) + MIN_CURSOR;
}
export const MIN_CURSOR = 1
export function tagName(cursor: number) {
    return `tag_${cursor}`;
}
export async function seedFilterDataset(
    SEED_N: number,
    SEED_TAG_COUNT: number,
    SEED_SHIFTS: number, //aka tags per track
    progress: (message: string, add: boolean) => void
) {
    // fot tracks [1,2,3,4,5,6] and tags [1,2,3] and 2 shifts
    // resulting assignements will be:
    // [t1: 1,3; t2: 1,3; t3: 2,1; t4: 2,1; t5: 3,2; t6: 3,2]
    const tagIds: number[] = [];
    for (let t = MIN_CURSOR; t <= SEED_TAG_COUNT; t++) {
        tagIds.push(await addTag(tagName(t)));
    }
    progress(`Inserted ${SEED_TAG_COUNT} tags.`, true);
    // Insert tracks
    const trackIds: number[] = await addTracks(Array.from({ length: SEED_N }, (_, i) => ({
        artist: `A_${artistIdx(i + 1, SEED_N)}`,
        track_name: `t${i + 1}`,
        length_seconds: 100,
        bitrate_kbps: 160,
        tempo_bpm: 120,
        addition_time: "2026-01-01",
        sources: [`https://example.com/track_${i + 1}.mp3`],
    })));
    progress(`Inserted ${SEED_N} tracks.`, true);
    // Assign tags (same layout as testdb.rs)
    const tagAssignements: TagAssignment[] = trackIds.map((trackId, i) => {
        const res = {
            track_id: trackId,
            tag_ids: Array.from({ length: SEED_SHIFTS }, (_, shift) => calcTag(i, shift, SEED_N, SEED_TAG_COUNT)),
        };
        return res;
    });
  
    progress(`Prepared ${tagAssignements.length * SEED_SHIFTS} assignements.`, true);
    await assignTags(tagAssignements);

    progress(`Seeding finished`, true   );
}
export type SelectorForExpected = (row: TrackRow, tags: string[], sources: string[]) => boolean;
export function expectedRegularRetrievalRes(cursor: number, 
    limit: number,
    SEED_N: number,
    SEED_TAG_COUNT: number,
    SEED_SHIFTS: number,
    selectorForExpected?: SelectorForExpected
): TrackRow[] {
    if (cursor < MIN_CURSOR) {
        throw new Error(`Cursor ${cursor} is out of bounds (must be >= ${MIN_CURSOR})`);
    }
    const res: TrackRow[] = [];
    for (let i = cursor; res.length < limit && i <= SEED_N; i++) {
        const row = {
            id: i,
            artist: `A_${artistIdx(i, SEED_N)}`,
            track_name: `t${i}`,
            length_seconds: 100,
            bitrate_kbps: 160,
            tempo_bpm: 120,
            addition_time: "2026-01-01",
        };
        const tags = Array.from({ length: SEED_SHIFTS }, (_, shift) => tagName(calcTag(i - 1, shift, SEED_N, SEED_TAG_COUNT)));
        const sources = [`https://example.com/track_${i}.mp3`];
        if (!selectorForExpected || selectorForExpected(row, tags, sources)) {
            res.push(row);
        }
    }
    return res;
}
