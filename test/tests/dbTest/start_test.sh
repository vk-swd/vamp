# #!/bin/bash
# just to save this pain for history
# set -e

# TEST_DIR="/tmp/dir_for_tests"
# mkdir -p "$TEST_DIR"
# rm -rf "$TEST_DIR"/*

# SCRIPT_PATH="$(pwd)/mockPage.html" 
# TEST_PROJECT_MANIFEST="$(pwd)/../../../src-tauri/Cargo.toml"

# NPM_PREFIX="$(pwd)/../../../"
# VITE_CONFIG="$(pwd)/vite.conf.ts"
# VITE_INPUT="$(pwd)/mockPage.html"
# TS_SRC="$(pwd)/../../../src"
# NPX_OUT_DIR="$NPM_PREFIX/dist"
# TAURI_CONFIG='{"build":{"frontendDist":"/home/ho/test/tests/dbTest/dist"}}'

# VITE_CONFIG="$VITE_CONFIG" TS_SRC="$TS_SRC" VITE_INPUT="$VITE_INPUT" NPX_OUT_DIR="$NPX_OUT_DIR" npm --prefix "$NPM_PREFIX" run testvite
# MOCK_PAGE="$SCRIPT_PATH" TEST_DIR="$TEST_DIR" SCRIPT_PATH="$SCRIPT_PATH" RUST_LOG=trace cargo build --manifest-path "$TEST_PROJECT_MANIFEST" --bin vampagent

