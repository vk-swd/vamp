import { addTrack, getTracks, getTracksFiltered } from "../../db/tauriDb";
import { log } from "../../logger";

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
    const tracks = await getTracksFiltered(0, [
        {
            filter_name: "artist", 
            criteria: [
                {mode: "text_like", pattern: "1", case_sensitive: false},
                {mode: "text_like", pattern: "3", case_sensitive: false}
            ]
        },
        {
            filter_name: "track_name", 
            criteria: [
                {mode: "text_like", pattern: "1", case_sensitive: false}
            ]
        }
    ], 
    10);
    log(`Retrieved tracks: ${JSON.stringify(tracks, null, 2)}`);
}