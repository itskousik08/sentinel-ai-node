# 🛡️ SENTINEL AI — Node.js Mobile Surveillance System

> A **professional, portable AI surveillance system** built with Node.js + Socket.io.  
> Runs **fully offline** on Android via **Termux**. Human detection via TensorFlow.js COCO-SSD.  
> Built by **AxeroAI · Kousik Debnath**

---

## 📸 System Overview

```
Browser (Mobile Chrome/Firefox)           Node.js Server (Termux)
─────────────────────────────            ────────────────────────
 📷 Camera (getUserMedia)    ──frames──▶  Socket.io relay
 🤖 TF.js COCO-SSD detect   ──events──▶  Detection log
 🗺️  Canvas HUD overlay       ──snaps───▶  Snapshot storage
 📍 GPS (Geolocation API)   ◀──status──  API endpoints
```

**Why browser-side detection?**  
Termux can't access mobile camera hardware natively from Node.js. Running TF.js in the browser (where WebRTC + GPU are available) gives you real-time AI inference — then Socket.io relays everything to the server for logging, coordination, and multi-client broadcast.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎯 Human Detection | TF.js COCO-SSD (lite_mobilenet_v2) — filters `person` class |
| 🖥️ Dual URL System | Feed page (URL 1) + Full dashboard (URL 2) |
| 📡 Socket.io Relay | Live frame relay from feed → dashboard in real-time |
| 📍 Real GPS | Browser Geolocation API (with simulation fallback) |
| 🌡️ Temperature | Simulated (real sensor via `/sys/class/thermal/`) |
| ⚠️ Alert Mode | Red overlay flash, banner, all clients notified |
| 📸 Snapshots | Canvas frame → POST to server → saved as JPEG |
| 📋 Detection Log | Timestamped, confidence-scored records |
| 🌐 LAN Access | `http://<phone-IP>:3000` from any device on same Wi-Fi |
| 📴 Offline Ready | Works without internet after first model load |

---

## 📱 Quick Start — Termux on Android

### Step 1 — Install Termux
- Download **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) *(not Play Store — that version is outdated)*
- Open Termux

### Step 2 — Install Node.js

```bash
# Update package lists
pkg update && pkg upgrade -y

# Install Node.js (includes npm)
pkg install nodejs -y

# Verify installation
node --version   # should show v18+ or v20+
npm --version
```

### Step 3 — Clone the Repository

```bash
# Install git if needed
pkg install git -y

# Clone
git clone https://github.com/YOUR_USERNAME/sentinel-ai-node.git
cd sentinel-ai-node
```

### Step 4 — Install Dependencies

```bash
npm install
```

> ⏱️ First install takes ~1-2 minutes (downloads express, socket.io, etc.)  
> Total install size: ~15MB

### Step 5 — Start the System

```bash
node start
```

You should see:
```
╔══════════════════════════════════════════════════════╗
║       SENTINEL AI — SURVEILLANCE NODE SERVER         ║
╠══════════════════════════════════════════════════════╣
║  📡  URL 1 (Feed)      → http://localhost:3000/      ║
║  🖥   URL 2 (Dashboard) → http://localhost:3000/dashboard ║
╚══════════════════════════════════════════════════════╝
```

### Step 6 — Open in Browser

Open **Chrome or Firefox** on your Android device:

| URL | Page |
|---|---|
| `http://localhost:3000/` | 📡 Live camera feed + controls |
| `http://localhost:3000/dashboard` | 🖥️ Full command dashboard |

> **First visit**: The browser will load TF.js + COCO-SSD from CDN (~8MB).  
> After that, it's cached and works **offline**.

---

## 🌐 Access from Another Device (LAN)

```bash
# Find your phone's IP address
ifconfig wlan0
# or
ip addr show wlan0
```

Then from any device on the same Wi-Fi:
```
http://192.168.x.x:3000/dashboard
```

---

## 📁 Project Structure

```
sentinel-ai-node/
├── start.js                    # ← Main server (Express + Socket.io)
├── package.json                # ← Dependencies
├── README.md
├── .gitignore
├── public/
│   ├── index.html              # ← URL 1: Camera feed page
│   ├── dashboard.html          # ← URL 2: Command dashboard
│   ├── css/
│   │   └── sentinel.css        # ← Shared tactical styles
│   └── js/
│       └── detection.js        # ← TF.js detection engine class
└── snapshots/                  # ← Auto-created; saved JPEG snapshots
```

---

## 🔧 Configuration

Edit the `CONFIG` object at the top of `start.js`:

```javascript
const CONFIG = {
  port:              3000,     // Change if needed
  host:              '0.0.0.0', // '0.0.0.0' = LAN accessible
  maxDetectionLog:   200,      // Max records in memory
  frameRelayEnabled: true,     // Relay frames to dashboard
};
```

Detection sensitivity in `public/js/detection.js`:

```javascript
this.opts = {
  detectionInterval: 4,   // Run AI every N frames (lower = more CPU)
  confidence:        0.45, // 0.0–1.0 detection threshold
  jpegQuality:       0.70, // Frame quality sent to server
};
```

---

## 🌡️ Real Temperature Sensor

In `start.js`, the `get_temperature()` approach can be adapted.  
Or add a route that reads from Android thermal zone:

```javascript
// In start.js
const fs = require('fs');

app.get('/api/temperature', (req, res) => {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    res.json({ temp: parseInt(raw) / 1000 });
  } catch {
    res.json({ temp: 28.0 }); // fallback
  }
});
```

---

## 📍 Real GPS (Production Mode)

The system uses **browser Geolocation API** automatically. No extra setup needed.  
Just grant location permission when the browser asks.

For command-line GPS via Termux:API:
```bash
# Install Termux:API app from F-Droid
pkg install termux-api
termux-location
```

---

## ⬆️ Push to GitHub

```bash
git init
git add .
git commit -m "feat: SENTINEL AI Node.js v1.0"
git remote add origin https://github.com/YOUR_USERNAME/sentinel-ai-node.git
git push -u origin main
```

---

## 🚀 Roadmap

- [ ] Multi-camera support (IP camera RTSP streams)
- [ ] Drone feed integration via WebRTC
- [ ] IoT sensor overlay (PIR motion, ultrasonic distance)
- [ ] Local SQLite database for persistent detection log
- [ ] Termux push notifications on detection
- [ ] H.264 video recording to disk
- [ ] Night vision / IR mode toggle
- [ ] Custom zone-based intrusion detection

---

## ⚖️ License

MIT — for educational, research, and personal security use only.  
Use responsibly and in compliance with local privacy laws.

---

*Built with ⚡ by AxeroAI — Kousik Debnath*
