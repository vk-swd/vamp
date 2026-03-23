CREATE TABLE IF NOT EXISTS listened_daily (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT    NOT NULL,
    track_id  INTEGER NOT NULL REFERENCES track_info(id) ON DELETE CASCADE,
    listened  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, track_id)
);
