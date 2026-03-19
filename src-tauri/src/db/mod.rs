// ============================================================
// Add the following entries to src-tauri/Cargo.toml [dependencies]:
//
//   sqlx        = { version = "0.8", features = ["sqlite", "runtime-tokio", "macros"] }
//   async-trait = "0.1"
//
// The "macros" feature is only needed for #[derive(sqlx::FromRow)] and
// sqlx::migrate!().  No `sqlx prepare` or DATABASE_URL env-var is required
// because all queries are written as runtime strings (sqlx::query /
// sqlx::query_as), never the compile-time macros (query! / query_as!).
// ============================================================

pub mod repository;
pub mod schema;
pub mod sqlite;
