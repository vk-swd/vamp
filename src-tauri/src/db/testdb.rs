#[cfg(test)]
mod perf {
    use std::time::Instant;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    use crate::db::repository::AppRepository;
    use crate::db::schema::{SearchCriteria, SearchParam};
    use crate::db::sqlite::SqliteRepository;

    // ── dataset constants ───────────────────────────────────────────────────
    const N: usize = 50_000;          // total tracks
    const TN: usize = 200;            // total tags
    const SHIFTS: usize = 10;         // how many tag-offset rounds
    const BATCH: usize = N / TN;      // 250 tracks per tag-batch
    const ARTIST_COUNT: usize = N / 1000; // 50 artists

    const DB_PATH: &str = "/tmp/vampagent_perf_test.db";

    // ── seeding ─────────────────────────────────────────────────────────────

    /// Open a raw sqlx pool for bulk inserts.
    /// FK checks are disabled for seeding speed; the data is consistent by
    /// construction so we don't need them here.
    async fn open_seed_pool(path: &str) -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .pragma("foreign_keys", "OFF")
            .create_if_missing(false);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap()
    }

    async fn seed(pool: &SqlitePool) {
        // ── tracks ──────────────────────────────────────────────────────────
        // 50 artists (A_1 … A_50), track names are just the track index,
        // length = 100 for every row.
        println!("  inserting {} tracks in chunks of 5 000 …", N);
        for chunk_start in (0..N).step_by(5_000) {
            let chunk_end = (chunk_start + 5_000).min(N);
            let mut tx = pool.begin().await.unwrap();
            for i in (chunk_start + 1)..=chunk_end {
                let artist_idx = ((i - 1) % ARTIST_COUNT) + 1;
                sqlx::query(
                    "INSERT INTO track_info \
                     (artist, track_name, length_seconds, bitrate_kbps, tempo_bpm, addition_time) \
                     VALUES (?, ?, 100, NULL, NULL, '2026-01-01')",
                )
                .bind(format!("A_{}", artist_idx))
                .bind(i.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();
        }
        println!("  tracks done");

        // ── tags ─────────────────────────────────────────────────────────────
        println!("  inserting {} tags …", TN);
        let mut tx = pool.begin().await.unwrap();
        for t in 1..=TN {
            sqlx::query("INSERT INTO tags (tag_name) VALUES (?)")
                .bind(format!("tag_{}", t))
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        println!("  tags done");

        // ── tag assignments ──────────────────────────────────────────────────
        //
        // Layout (SHIFTS rounds of TN batches):
        //   shift s, batch b  →  tag (b+s) % TN + 1  →  tracks b*BATCH+1 … (b+1)*BATCH
        //
        // Result: every tag is assigned to exactly SHIFTS * BATCH = 2 500 distinct
        // tracks; every track receives exactly SHIFTS = 10 tags.
        // No (track_id, tag_id) pair repeats, so INSERT OR IGNORE is just safety.
        //
        // Total rows: N * SHIFTS = 500 000
        let total = N * SHIFTS;
        println!("  inserting {} tag assignments in chunks of 10 000 …", total);
        let mut count = 0usize;
        let mut tx = pool.begin().await.unwrap();
        for shift in 0..SHIFTS {
            for batch in 0..TN {
                let tag_id = ((batch + shift) % TN + 1) as i64;
                let track_start = (batch * BATCH + 1) as i64;
                let track_end = ((batch + 1) * BATCH) as i64;
                for track_id in track_start..=track_end {
                    sqlx::query(
                        "INSERT OR IGNORE INTO tag_assignments (track_id, tag_id) VALUES (?, ?)",
                    )
                    .bind(track_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                    count += 1;
                    if count % 10_000 == 0 {
                        tx.commit().await.unwrap();
                        tx = pool.begin().await.unwrap();
                        println!("  assigned {}/{}", count, total);
                    }
                }
            }
        }
        tx.commit().await.unwrap(); // flush remainder
        println!("  tag assignments done ({} rows)", count);
    }

    // ── query helpers ────────────────────────────────────────────────────────

    fn tag_criteria(tag_ids: Vec<i64>) -> Vec<SearchCriteria> {
        vec![SearchCriteria {
            column_name: "tags".to_string(),
            criteria: vec![SearchParam::TagsIn { tag_ids }],
        }]
    }

    async fn first_page(repo: &SqliteRepository, tag_ids: Vec<i64>) -> (usize, std::time::Duration) {
        let t = Instant::now();
        let rows = repo
            .get_tracks(None, Some(tag_criteria(tag_ids)), 100)
            .await
            .unwrap();
        (rows.len(), t.elapsed())
    }

    async fn full_scan(repo: &SqliteRepository, tag_id: i64) -> (usize, std::time::Duration) {
        let mut cursor = None;
        let mut total = 0usize;
        let t = Instant::now();
        loop {
            let page = repo
                .get_tracks(cursor, Some(tag_criteria(vec![tag_id])), 100)
                .await
                .unwrap();
            let done = page.len() < 100;
            total += page.len();
            cursor = page.last().map(|r| r.id);
            if done {
                break;
            }
        }
        (total, t.elapsed())
    }

    // ── test ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn perf_tag_lookup() {
        let _ = std::fs::remove_file(DB_PATH);

        // Repo creation runs sqlx migrations.
        let repo: SqliteRepository = SqliteRepository::new(DB_PATH).await.unwrap();

        // Seed via a separate raw pool, then drop it before any queries so
        // there's no concurrent writer risk.
        {
            let seed_pool = open_seed_pool(DB_PATH).await;
            let t = Instant::now();
            seed(&seed_pool).await;
            println!("Seeding complete in {:.2?}\n", t.elapsed());
        }

        // ── single-tag, first page ────────────────────────────────────────
        println!("=== single-tag, first page (limit 100) ===");
        // Spread across the tag range so we hit different parts of the index.
        for tag_id in [1i64, 25, 50, 75, 100, 125, 150, 175, 200] {
            let (n, elapsed) = first_page(&repo, vec![tag_id]).await;
            println!("  tag {:3}  {:3} rows  {:?}", tag_id, n, elapsed);
        }

        // ── single-tag, full paginated scan ──────────────────────────────
        println!("\n=== single-tag, full paginated scan (limit 100) ===");
        for tag_id in [1i64, 100, 200] {
            let (total, elapsed) = full_scan(&repo, tag_id).await;
            println!("  tag {:3}  {:5} total  {:?}", tag_id, total, elapsed);
        }

        // ── multi-tag, first page ─────────────────────────────────────────
        println!("\n=== multi-tag, first page (limit 100) ===");
        let multi_cases: &[&[i64]] = &[
            &[1, 2],
            &[1, 100, 200],
            &[50, 51, 52, 53, 54],
        ];
        for &tag_ids in multi_cases {
            let (n, elapsed) = first_page(&repo, tag_ids.to_vec()).await;
            println!("  tags {:?}  {:3} rows  {:?}", tag_ids, n, elapsed);
        }

        // ── multi-tag, full paginated scan ────────────────────────────────
        println!("\n=== multi-tag, full paginated scan (limit 100) ===");
        for &tag_ids in multi_cases {
            let mut cursor = None;
            let mut total = 0usize;
            let t = Instant::now();
            loop {
                let page = repo
                    .get_tracks(cursor, Some(tag_criteria(tag_ids.to_vec())), 100)
                    .await
                    .unwrap();
                let done = page.len() < 100;
                total += page.len();
                cursor = page.last().map(|r| r.id);
                if done {
                    break;
                }
            }
            println!("  tags {:?}  {:5} total  {:?}", tag_ids, total, t.elapsed());
        }
    }
}
