# Installation

## Prerequisites

- **Node.js** (v18+) and **npm**
- **Rust** (stable toolchain via [rustup](https://rustup.rs))
- **Linux system dependencies** (required by Tauri + WebKit):

```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

## Development

```bash
# 1. Clone the repository
git clone <repo-url>
cd vampagent

# 2. Install JavaScript dependencies
npm install

# 3. Start the development build (Vite + Tauri)
npx tauri dev
```

### Environment variables

| Variable   | Effect |
|------------|--------|
| `VAMP_DIR` | Use a custom directory for the database file (`vampa.db`). |
| `TEST_DIR` | Use a custom directory with a fresh timestamped database (for testing). |

```bash
# Custom database location
VAMP_DIR=/path/to/dir npx tauri dev

# Isolated test database
TEST_DIR=/tmp/mytest npx tauri dev
```

## Release build

```bash
npx tauri build
```

The compiled binary and installer bundles are written to `src-tauri/target/release/bundle/`.
