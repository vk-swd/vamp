import { FilterSearchParam } from "../../db/generatedTypes";
import { addTag, addTrack, assignTag, CriteriaName, getAllTags, getTracks, getTracksFiltered, SearchCriteriaFiltered, SearchParam } from "../../db/tauriDb";
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
export async function initDb() {
    await addTrack(makeTrack("test track 1", "artist 1"));
    await addTrack(makeTrack("test track 2", "artist 1"));
    await addTrack(makeTrack("test track 3", "artist 2"));
    await addTrack(makeTrack("test track 4", "artist 2"));
    await addTrack(makeTrack("test track 13", "artist 3"));
    await addTrack(makeTrack("test track 1", "artist 3"));
    const allTracks = await getTracks(0, null, 100);
    expect(allTracks).toHaveLength(6);
    await addTag("aaaa");
    await addTag("bbbb");
    await addTag("cccc");
    const allTags = await getAllTags();
    expect(allTags.map(t => t.tag_name)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(allTags).toHaveLength(3);
    // log(`allTags OK: ${JSON.stringify(tagNames)}`);

    await assignTag(allTracks[0].id, allTags[0].id);
    await assignTag(allTracks[1].id, allTags[1].id);
    await assignTag(allTracks[2].id, allTags[2].id);
    await assignTag(allTracks[4].id, allTags[0].id);
    await assignTag(allTracks[4].id, allTags[1].id);
    await assignTag(allTracks[4].id, allTags[2].id);

    function textLike(pattern: string): FilterSearchParam {
        return {mode: "text_like", pattern, case_sensitive: false}
    }
    function criteria(field: CriteriaName, criterias: FilterSearchParam[]): SearchCriteriaFiltered {
        return {filter_name: field, criteria: criterias}
    }
    function tagsIn(tagIds: number[]): FilterSearchParam {
        return {mode: "tags_all", tag_ids: tagIds}
    }
    const tracks = await getTracksFiltered(0, [
        criteria("artist", [textLike("1"), textLike("3")]),
        criteria("track_name", [textLike("1")]),
        criteria("tags", [tagsIn([allTags[2].id])])
    ], 
    10);
    log(`Retrieved tracks: ${JSON.stringify(tracks, null, 2)}`);
}