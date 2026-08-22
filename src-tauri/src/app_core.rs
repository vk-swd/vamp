use std::sync::Arc;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::RwLock;
use crate::db::repository::ArcRepo;
use crate::commands::listen_guard::ArcListenGuard;
use crate::transport;
use std::net::SocketAddr;

pub struct AppCore {
    pub repo: RwLock<Option<ArcRepo>>,
    pub guard: ArcListenGuard,
    db_dir: PathBuf,
    is_test: bool,
}

impl AppCore {
    /// Closes the current database and opens a brand-new one (new datetime-based
    /// filename) in the same directory. Sleeps 2s before creating the new database
    /// so that the datetime-based filename is guaranteed to be unique.
    pub async fn reset_database(&self) -> Result<(), String> {
        if !self.is_test {
            return Err("reset_database is only allowed in test mode".to_string());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        println!("[AppCore] Resetting database...");
        let filename = chrono::Local::now().format("%Y:%m:%d_%H:%M:%S").to_string() + "_vampa.db";
        let new_path = self.db_dir.join(filename);
        let new_repo: ArcRepo = crate::commands::create_repo(new_path, self.is_test).await?;

        let mut repo_guard = self.repo.write().await;
        
        *repo_guard = Some(new_repo);
        Ok(())
    }
}

pub async fn make_app_core() -> crate::commands::common::MyRes<Arc<AppCore>> {
    let db_config = crate::db_config::create_db_config();

    std::fs::create_dir_all(&db_config.db_path).expect("failed to create db directory");
    let db_full_path = db_config.db_path.join(&db_config.db_filename);

    let repo: ArcRepo = crate::commands::create_repo(db_full_path, db_config.is_test)
        .await
        .map_err(|e| e)?;
    let guard = crate::commands::listen_guard::ListenGuard::new();
    Ok(Arc::new(AppCore {
        repo: RwLock::new(Some(repo)),
        guard,
        db_dir: db_config.db_path,
        is_test: db_config.is_test,
    }))
}


