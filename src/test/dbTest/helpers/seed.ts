import { addTag, addTrack, assignTag, TrackRow } from "../../../db/tauriDb";

// Mini-seed constants — 1/10th of testdb.rs for speed
// const SEED_N            = 5000;
// const SEED_TAG_COUNT    = 200;
// const SEED_SHIFTS       = 5;
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
const MIN_CURSOR = 1
export function tagName(cursor: number) {
    return `tag_${cursor}`;
}
export async function seedFilterDataset(
    SEED_N: number,
    SEED_TAG_COUNT: number,
    SEED_SHIFTS: number, //aka tags per track
    progress: (message: string) => void
) {
    // fot tracks [1,2,3,4,5,6] and tags [1,2,3] and 2 shifts
    // resulting assignements will be:
    // [t1: 1,3; t2: 1,3; t3: 2,1; t4: 2,1; t5: 3,2; t6: 3,2]
    // Insert tags
    const tagIds: number[] = [];
    for (let t = MIN_CURSOR; t <= SEED_TAG_COUNT; t++) {
        tagIds.push(await addTag(tagName(t)));
    }
    progress(`Inserted ${SEED_TAG_COUNT} tags.`);
    // Insert tracks
    const trackIds: number[] = [];
    for (let i = MIN_CURSOR; i <= SEED_N; i++) {
        const id = await addTrack({
            artist: `A_${artistIdx(i, SEED_N)}`,
            track_name: `t${i}`,
            length_seconds: 100,
            bitrate_kbps: 160,
            tempo_bpm: 120,
            addition_time: "2026-01-01",
            sources: [`https://example.com/track_${i}.mp3`],
        });
        trackIds.push(id);
    }
    progress(`Inserted ${SEED_N} tracks.`);
    // Assign tags (same layout as testdb.rs)
    for (let shift = 0; shift < SEED_SHIFTS; shift++) {
        for (let i = 0; i < SEED_N; i++) {
            const cursor = MIN_CURSOR + i;
            const tagToAssign = calcTag(i, shift, SEED_N, SEED_TAG_COUNT);
            await assignTag(cursor, tagToAssign);
        }
        progress(`Generated tag assignments with shift ${shift + 1}/${SEED_SHIFTS}.`);
    }
    progress(`Seeding finished`);
}

export function expectedRegularRetrievalRes(cursor: number, 
    limit: number,
    SEED_N: number,
    SEED_TAG_COUNT: number,
    SEED_SHIFTS: number,
    filter?: (row: TrackRow, tags: string[], sources: string[]) => boolean
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
        if (!filter || filter(row, tags, sources)) {
            res.push(row);
        }
    }
    return res;
}
