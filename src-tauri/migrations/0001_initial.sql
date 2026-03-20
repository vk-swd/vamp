CREATE TABLE IF NOT EXISTS track_info (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artist          TEXT    NOT NULL,
    track_name      TEXT    NOT NULL,
    length_seconds  INTEGER NOT NULL,
    bitrate_kbps    INTEGER,
    tempo_bpm       REAL,
    addition_time   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS track_sources (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE,
    url       TEXT    NOT NULL,
    UNIQUE(track_id, url)
);

CREATE TABLE IF NOT EXISTS listen_info (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id       INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE,
    listened_from  INTEGER NOT NULL,
    listened_to    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_name  TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tag_assignments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id)       ON DELETE CASCADE,
    UNIQUE(track_id, tag_id)
);

CREATE TABLE IF NOT EXISTS track_meta (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE,
    key       TEXT    NOT NULL,
    value     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
    key         INTEGER PRIMARY KEY AUTOINCREMENT,
    error_text  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS track_add_conflicts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artist          TEXT    NOT NULL,
    track_name      TEXT    NOT NULL,
    length_seconds  INTEGER,
    bitrate_kbps    INTEGER,
    tempo_bpm       REAL,
    addition_time   TEXT    NOT NULL,
    conflict_reason TEXT    NOT NULL,
    same_track_id   INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE
);
