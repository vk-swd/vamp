# signalling-server

Rust port of `src/transport/sserver.ts`.  
A lightweight WebSocket signalling server that routes messages between
registered peers by address token.  Supports plain WS and TLS (WSS) via
environment variable configuration.

---

## Building on RHEL 9

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 2. Build a release binary

```bash
cd signalling-server
cargo build --release
```

The binary is produced at `target/release/signalling-server`.  
It is statically linked against Rust's stdlib and uses **rustls** (no OpenSSL
dependency), so it runs on any RHEL 9 machine without extra packages.

To cross-compile from another host targeting RHEL 9 (x86-64):

```bash
rustup target add x86_64-unknown-linux-gnu
cargo build --release --target x86_64-unknown-linux-gnu
```

---

## Runtime configuration

All options are set via environment variables.

| Variable  | Default  | Description                              |
|-----------|----------|------------------------------------------|
| `SS_PORT` | `9001`   | TCP port to listen on                    |
| `SS_CERT` | *(unset)*| Path to PEM certificate file (WSS only)  |
| `SS_KEY`  | *(unset)*| Path to PEM private-key file (WSS only)  |

If both `SS_CERT` and `SS_KEY` are set the server upgrades to WSS (TLS).  
The key file may contain PKCS#8, PKCS#1 (RSA), or SEC1 (EC) keys.

### Plain WS example

```bash
SS_PORT=9001 ./signalling-server
```

### WSS example

```bash
SS_PORT=9443 SS_CERT=/etc/pki/tls/certs/ss.crt SS_KEY=/etc/pki/tls/private/ss.key \
  ./signalling-server
```

---

## Deploying as a systemd service on RHEL 9

1. Copy the binary:

```bash
sudo cp target/release/signalling-server /usr/local/bin/
sudo chmod 755 /usr/local/bin/signalling-server
```

2. Create the unit file `/etc/systemd/system/signalling-server.service`:

```ini
[Unit]
Description=WebSocket Signalling Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/signalling-server
Restart=on-failure
RestartSec=5

# Tune these as needed
Environment="SS_PORT=9001"
# Environment="SS_CERT=/etc/pki/tls/certs/ss.crt"
# Environment="SS_KEY=/etc/pki/tls/private/ss.key"

# Run as a dedicated user (recommended)
# User=ssserver
# Group=ssserver

# Harden the service
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

3. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now signalling-server
sudo systemctl status signalling-server
```

4. Open the firewall port (firewalld):

```bash
sudo firewall-cmd --permanent --add-port=9001/tcp
sudo firewall-cmd --reload
```

---

## Protocol

Identical to the TypeScript implementation:

- Clients connect and send JSON messages of the shape:
  ```json
  { "originType": "client", "src": "<my-token>", "dst": "<peer-token>", "payload": "..." }
  ```
- Setting `dst == src` registers (announces) the address with no forwarding.
- Messages with a known `dst` are forwarded verbatim to whichever connection
  owns that address.
- A connection may register at most **3** addresses (`ROUTE_LIMIT = 2`, check
  is `> ROUTE_LIMIT`); further registrations receive an error response.
- Error responses:
  ```json
  { "src": "error", "msg": "..." }
  ```

---

## Security notes

- Maximum message size is capped at **8 192 bytes** (mirrors `maxPayload: 8192`
  in the Node.js server).
- TLS uses **rustls** — no system OpenSSL required, no legacy protocol support.
- Consider putting the service behind an nginx reverse proxy for production use
  (rate limiting, access control, certificate management).
