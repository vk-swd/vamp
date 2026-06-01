import { FilterSearchParam } from "../../db/generatedTypes";
import { addTag, addTrack, addTracks, assignTag, assignTags, CriteriaName, getAllTags, getTracks, getTracksFiltered, SearchCriteriaFiltered, SearchParam, TagAssignment } from "../../db/tauriDb";
import { log } from "../../logger";
import { expect } from "vitest";

let globalCounter = 0;
function makeTrack(title: string, artist: string, sources?: string[]) {
    globalCounter++;
    return {
        artist:                             artist,
        track_name:                         title,
        length_seconds:                     0,
        bitrate_kbps:                       null,
        tempo_bpm:                          null,
        addition_time:                      `${globalCounter}`,
        listened_seconds:                   0,
        sources: sources?.length ? sources : [
            `file:///path/to/track1${globalCounter}.mp3`,
            `file:///path/to/track1${globalCounter}.flac`,
        ],
    }
}


function setTags(assignements: TagAssignment[]) {
    return Promise.all(assignements.map(a => {
        return Promise.all(a.tag_ids.map(tagId => assignTag(a.track_id, tagId)));
    }));
}
function textLike(pattern: string): FilterSearchParam {
    return {mode: "text_like", pattern, case_sensitive: false}
}
function criteria(field: CriteriaName, criterias: FilterSearchParam[]): SearchCriteriaFiltered {
    return {filter_name: field, criteria: criterias}
}
type TagsCriteria = { mode: "tags_any"; tag_ids: number[] } | { mode: "tags_all"; tag_ids: number[] };
function tagsIn(tagIds: number[]): TagsCriteria {
    return {mode: "tags_all", tag_ids: tagIds}
}
function tagsAny(tagIds: number[]): TagsCriteria {
    return {mode: "tags_any", tag_ids: tagIds}
}
export async function initDb() {
    await addTrack(makeTrack("test track 1", "artist 1"))
    await addTrack(makeTrack("test track 2", "artist 1"))
    await addTrack(makeTrack("test track 3", "artist 2"))
    await addTrack(makeTrack("test track 4", "artist 2"))
    await addTrack(makeTrack("test track 13", "artist 3"))
    await addTrack(makeTrack("test track 1", "artist 3"))

    const allTracks = await getTracks(0, null, 100);
    expect(allTracks).toHaveLength(6);
    await addTag("aaaa");
    await addTag("bbbb");
    await addTag("cccc");
    const allTags = await getAllTags();
    expect(allTags.map(t => t.tag_name)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(allTags).toHaveLength(3);
    // log(`allTags OK: ${JSON.stringify(tagNames)}`);

    await setTags([
        { track_id: allTracks[0].id, tag_ids: [allTags[0].id] },
        { track_id: allTracks[1].id, tag_ids: [allTags[1].id] },
        { track_id: allTracks[2].id, tag_ids: [allTags[2].id] },
        { track_id: allTracks[4].id, tag_ids: [allTags[0].id, allTags[1].id, allTags[2].id] },
    ]);


    const tracks = await getTracksFiltered(0, [
        criteria("artist", [textLike("1"), textLike("3")]),
        criteria("track_name", [textLike("1")]),
        criteria("tags", [tagsIn([allTags[2].id])])
    ], 
    10);
    expect(tracks).toHaveLength(1);
    const { id, artist, track_name } = tracks[0];
    log(`${id} ${artist} ${track_name} vs expected 6, artist 3, test track 1`)
    expect({ id, artist, track_name }).deep.equal({
        id: 5,
        artist: "artist 3",
        track_name: "test track 13",
    });
}


export async function Test1() {
    const ARTISTS = 100;
    const TRACKS_PER = 1000;
    const TAGS_PER_TRACK = 2;
    const TAG_COUNT = 1000;
    const TAG_CHUNK_COUNT = TAG_COUNT / TAGS_PER_TRACK;
    if (TAG_CHUNK_COUNT % 1 !== 0) {
        throw new Error("TAG_COUNT must be divisible by TAGS_PER_TRACK");
    }
    const TOTAL = ARTISTS * TRACKS_PER;
    let counter = 0;

    // ── 1. Insert 1000 x 1000 records ─────────────────────────────────────
    
    for (let a = 1; a <= ARTISTS; a++) {
        const eb = new Array<any>();
        for (let t = 1; t <= TRACKS_PER; t++) {
            counter++;
            eb.push({
                artist: `a${a}`,
                track_name: `${t}`,
                length_seconds: 0,
                bitrate_kbps: null,
                tempo_bpm: null,
                addition_time: `${counter}`,
                listened_seconds: 0,
                sources: [`file:///tracks/${a}/${t}.mp3`],
            });
        }
        await addTracks(eb);
        log(`Inserted artist ${a} (${counter} tracks total)`);
    }
    

    for (let i = 1; i <= TAG_COUNT; i++) {
        await addTag(`t${i}`);
    }
    log(`Added ${TAG_COUNT} tags`);
    const tagAssignements: TagAssignment[] = [];
    for (let a = 1; a <= ARTISTS; a++) {
        for (let t = 1; t <= TRACKS_PER; t++) {
            // ids in a fresh database are assigned from 1.
            // It means that ids would follow the [artist id - 1][track id] pattern.
            // For example artist 1 and track 500 will give id 500
            // and artist 2 and track 500 will give id 1500 and so on.
            const expectedId = (a - 1) * TRACKS_PER + t;
            tagAssignements.push({
                track_id: expectedId,
                tag_ids: [],
            });
        }
    }
    class TagIdStamper {
        private tagId = 0
        constructor(private tagCount: number) {}
        stamp() {
            const id = this.tagId;
            this.tagId = (this.tagId + 1) % this.tagCount;
            return id;
        }
        reset() { this.tagId = 0 }
    }

    const assignTag = (assignement: TagAssignment, stamper: TagIdStamper) => {
        const tagId = 1 + stamper.stamp();
        assignement.tag_ids.push(tagId);
        if (!tagAssignementsReversIdx.has(tagId)) {
            tagAssignementsReversIdx.set(tagId, new Set());
        }
        tagAssignementsReversIdx.get(tagId)!.add(assignement.track_id);
    }
    const tagIdStamper = new TagIdStamper(TAG_COUNT);
    const tagAssignementsReversIdx: Map<number, Set<number>> = new Map();
    for (const assignement of tagAssignements) {
        assignTag(assignement, tagIdStamper);
        assignTag(assignement, tagIdStamper);
    }

    await assignTags(tagAssignements);
    log(`Assigned tags to ${tagAssignements.length} tracks`);
    function getMatchesOfNumbersForNamesStringed(criteria: number, maxName: number): Array<number> {
        const res = Array<number>();
        for (let i = 1; i <= maxName; i++) {
            if (String(i).includes(String(criteria))) {
                res.push(i);
            }
        }
        return res;
    }
    const testTrackId = (tags: TagsCriteria, trackId: number) => {
        if (tags.mode === "tags_all") {
            return tags.tag_ids.every(t => tagAssignementsReversIdx.get(t)?.has(trackId)) ?? false;
        }
        if (tags.mode === "tags_any") {
            return tags.tag_ids.some(t => tagAssignementsReversIdx.get(t)?.has(trackId)) ?? false;
        }
        return false;
    }
    const getFilteredTracks = (artistLike: number, trackLike: number, tagIds: TagsCriteria) => {
        const artists = getMatchesOfNumbersForNamesStringed(artistLike, ARTISTS)
        const tracks = getMatchesOfNumbersForNamesStringed(trackLike, TRACKS_PER)
        log(`Looking for artists ${artists.join(',')} and tracks ${tracks.join(',')}`);
        const ids = new Array<number>();
        for (const a of artists) {
            for (const t of tracks) {
                const trackId = (a - 1) * TRACKS_PER + t;
                if (testTrackId(tagIds, trackId)) {
                    ids.push(trackId);
                }
            }
        }
        return ids;
    }

    async function runTest(artistLike: number, trackLike: number, tagIds: TagsCriteria) {
        const expected = getFilteredTracks(artistLike, trackLike, tagIds);
        expect(expected.length).toBeGreaterThan(0);
        const PAGE_STEP = 5;
        const PAGE_SIZE = 10;
        let cursor = 0;
        for (let i = 0; i < expected.length; i+= PAGE_STEP) {
            const expectedPageStart = Math.min(Math.max(0, i - PAGE_SIZE), expected.length);
            const expectedPageEnd = Math.min(expected.length, i + PAGE_SIZE);
            const tracks = await getTracksFiltered(cursor, [
                criteria("artist", [textLike(`${artistLike}`)]),
                criteria("track_name", [textLike(`${trackLike}`)]),
                criteria("tags", [tagIds])
            ],
            PAGE_SIZE);
            const realExp = expected.slice(expectedPageStart, expectedPageEnd);
            // log(`Expected ${realExp.join(',')} tracks, \n got ${tracks.map(t => t.id).join(',')}`);
            expect(tracks.map(t => t.id)).toEqual(realExp);
            cursor = expected[Math.min(i + PAGE_STEP, expected.length - 1)];
        }
    }
    runTest(1, 5, tagsIn([1,2]));
    runTest(1, 5, tagsAny([1,3,9]));    
}