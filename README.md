# Heist

<p align="center">
  <img src="branding/Heist.png" alt="Heist Logo" width="120" />
</p>

<h3 align="center">Centralized Android Fleet Test Orchestration Engine & System Tray Bridge</h3>

---

## 🌟 Overview

**Heist** is a distributed test automation platform migrated from ATM Bersama. It decouples the test control UI from execution nodes:
- **Heist Web Hub**: Central web dashboard & WebSocket orchestrator (Docker container) served at `https://heist.endrisusanto.my.id`.
- **Heist Bridge**: Lightweight Rust + Tauri system tray agent running on each test PC node. It automatically discovers ADB devices and executes test suites without exposing incoming network ports.

---

## 📁 Repository Structure

```
Heist/
├── branding/                      # Official Heist mascot, logos, and raw assets
├── bridge/                        # Tauri v2 System Tray Fleet Agent (Rust)
│   ├── icons/                     # Multi-resolution icons & .ico / .icns
│   ├── resources/                 # Bundled Java batch launcher
│   ├── src/                       # Rust engine (scanner, runner, preflight, WS client)
│   └── ui/                        # Settings & tray popup window
├── web-hub/                       # Central Web & WebSocket Hub
│   ├── server/                    # Node.js + WebSocket server & static host
│   └── client/                    # Vite + TypeScript web dashboard
├── .github/workflows/release.yml  # Multi-platform CI/CD (.deb and .msi)
├── Dockerfile                     # Multi-stage container build
├── docker-compose.yml             # Container orchestration
└── package.json                   # Root workspace manifest
```

---

## 🚀 Getting Started

### 1. Running Heist Hub Locally

```bash
# Install dependencies
npm install

# Build client and server
npm run build

# Start Hub server (Default port 4020)
npm start
```

Open `http://localhost:4020` in your browser.

### 2. Deploying with Docker

```bash
docker compose up -d --build
```

### 3. Running Heist Bridge (PC Node)

```bash
cd bridge
cargo build --release
```

Run the binary:
- **Linux**: `./target/release/heist-bridge`
- **Windows**: `.\target\release\heist-bridge.exe`

Click the system tray icon to configure `Node ID`, `Hub URL`, and `ATM Root Directory`.

---

## 📦 Building Releases (.deb & .msi)

Push a version tag to trigger GitHub Actions:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will automatically compile and attach:
- `Heist Bridge .deb` (Ubuntu/Debian)
- `Heist Bridge .msi` (Windows)
to the GitHub Release page.

---

## 📄 License
Internal test automation platform.
