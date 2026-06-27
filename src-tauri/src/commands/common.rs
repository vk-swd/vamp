

use std::env;

pub fn get_env_str(var_name: &str, default: &str) -> String {
    env::var(var_name).unwrap_or(default.to_string())
}

pub fn get_env_num(var_name: &str, default: u16) -> u16 {
    env::var(var_name)
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(default)
}