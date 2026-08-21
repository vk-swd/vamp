use std::sync::Arc;
use crate::db::repository::ArcRepo;
use crate::commands::listen_guard::ArcListenGuard;
use crate::transport;
use std::net::SocketAddr;

#[derive(Clone)]
pub struct AppCore {
    pub repo: ArcRepo,
    pub guard: ArcListenGuard,
}

pub async fn make_app_core() -> crate::commands::common::MyRes<Arc<AppCore>> {
    let db_config = crate::db_config::create_db_config();

    std::fs::create_dir_all(&db_config.db_path).expect("failed to create db directory");
    let db_full_path = db_config.db_path.join(&db_config.db_filename);

    let repo: ArcRepo = crate::commands::create_repo(db_full_path, db_config.is_test)
        .await
        .map_err(|e| e)?;
    let guard = crate::commands::listen_guard::ListenGuard::new();
    Ok(Arc::new(AppCore { repo, guard }))
}


