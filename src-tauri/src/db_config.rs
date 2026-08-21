use std::path::PathBuf;

pub struct DbConfig {
    pub db_path: PathBuf,
    pub db_filename: String,
    pub is_test: bool,
}

enum LaunchMode {
    Test,
    DbFolderDefined,
    DefaultDb,
}

pub fn create_db_config() -> DbConfig {
    let test_dir_env = std::env::var("TEST_DIR");
    let app_dir_env = std::env::var("VAMP_DIR");

    let mut launch_mode = LaunchMode::DefaultDb;
    if app_dir_env.is_ok() {
        launch_mode = LaunchMode::DbFolderDefined;
    }
    if test_dir_env.is_ok() {
        launch_mode = LaunchMode::Test;
    }
    match launch_mode {
        LaunchMode::Test => DbConfig {
            db_path: PathBuf::from(test_dir_env.unwrap()),
            db_filename: chrono::Local::now().format("%Y%m%d_%H%M%S").to_string() + "_test.db",
            is_test: true,
        },
        LaunchMode::DbFolderDefined => DbConfig {
            db_path: PathBuf::from(app_dir_env.unwrap()),
            db_filename: "vampa.db".to_string(),
            is_test: false,
        },
        LaunchMode::DefaultDb => DbConfig {
            db_path: dirs::data_dir().unwrap(),
            db_filename: "vampagent3.db".to_string(),
            is_test: false,
        },
    }
}

pub fn create_window_config(port: u16) -> (usize, String) {
    let window_idx = if std::env::var("TEST_DIR").is_ok() { 1 } else { 0 };
    let mut url = format!("http://localhost:{}", port);
    if window_idx == 1 {
        url += "/src/test/dbTest/mockPage.html";
    }
    (window_idx, url)
}
