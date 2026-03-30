/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         SENTINEL AI — NODE.JS SURVEILLANCE SERVER           ║
 * ║         Express + Socket.io · Runs on Termux / Android      ║
 * ║         Author: AxeroAI · Kousik Debnath                    ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  URL 1: http://localhost:3000/         → Live camera feed   ║
 * ║  URL 2: http://localhost:3000/dashboard → Full dashboard    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Architecture:
 *   - Browser handles: camera capture, TF.js AI detection, canvas overlay
 *   - Server handles: Socket.io relay, detection log, snapshot storage, API
 *   - This design works perfectly on Termux (no native camera bindings needed)
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  port:               3000,
  host:               '0.0.0.0',        // Listen on all interfaces (LAN access)
  snapshotDir:        path.join(__dirname, 'snapshots'),
  maxDetectionLog:    200,              // Max records kept in memory
  maxSnapshotLog:     50,               // Max snapshot filenames kept
  frameRelayEnabled:  true,             // Relay frames to dashboard via Socket.io
  pingInterval:       5000,
  pingTimeout:        10000,
};

// ═══════════════════════════════════════════════════════════════
//  GLOBAL STATE  (in-memory, resets on restart)
// ═══════════════════════════════════════════════════════════════
const state = {
  cameraActive:    false,
  alertActive:     false,
  connectedClients: 0,
  totalDetections: 0,
  detectionLog:    [],   // [{ id, label, confidence, timestamp, lat, lon, temp }]
  snapshotLog:     [],   // [{ filename, timestamp, url }]
  lastFrame:       null, // base64 JPEG — latest camera frame from client
  systemLog:       [],   // [{ level, msg, ts }]
  fps:             0,
  detectorType:    'TF.js COCO-SSD',
};

// ═══════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════

// Ensure snapshots directory exists
if (!fs.existsSync(CONFIG.snapshotDir)) {
  fs.mkdirSync(CONFIG.snapshotDir, { recursive: true });
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:             { origin: '*' },
  pingInterval:     CONFIG.pingInterval,
  pingTimeout:      CONFIG.pingTimeout,
  maxHttpBufferSize: 5e6,  // 5MB — allows sending frame data
});

// ── Middleware ──────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve snapshots directory statically
app.use('/snapshots', express.static(CONFIG.snapshotDir));

// ── Utility: add system log entry ──────────────────────────────
function sysLog(level, msg) {
  const entry = { level, msg, ts: new Date().toISOString() };
  state.systemLog.unshift(entry);
  if (state.systemLog.length > 100) state.systemLog.pop();
  const icons = { info: '💬', ok: '✅', warn: '⚠️', alert: '🚨', error: '❌' };
  console.log(`[SENTINEL ${icons[level] || '·'}] ${msg}`);
  // Broadcast to all dashboard clients
  io.to('dashboard').emit('sys_log', entry);
}

// ═══════════════════════════════════════════════════════════════
//  REST API ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET /api/status ── System status summary ───────────────────
app.get('/api/status', (req, res) => {
  res.json({
    cameraActive:     state.cameraActive,
    alertActive:      state.alertActive,
    connectedClients: state.connectedClients,
    totalDetections:  state.totalDetections,
    detectionCount:   state.detectionLog.length,
    snapshotCount:    state.snapshotLog.length,
    fps:              state.fps,
    detectorType:     state.detectorType,
    uptime:           Math.floor(process.uptime()),
    timestamp:        new Date().toISOString(),
    nodeVersion:      process.version,
  });
});

// ── GET /api/detections ── Recent detection records ────────────
app.get('/api/detections', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(state.detectionLog.slice(0, limit));
});

// ── GET /api/snapshots ── Snapshot list ────────────────────────
app.get('/api/snapshots', (req, res) => {
  res.json(state.snapshotLog.slice(0, 20));
});

// ── POST /api/detections/clear ── Clear the log ────────────────
app.post('/api/detections/clear', (req, res) => {
  state.detectionLog = [];
  state.totalDetections = 0;
  io.emit('detections_cleared');
  sysLog('warn', 'Detection log cleared by operator.');
  res.json({ status: 'cleared' });
});

// ── POST /api/alert ── Toggle alert state ──────────────────────
app.post('/api/alert', (req, res) => {
  const { active } = req.body;
  state.alertActive = !!active;
  io.emit('alert_state', { active: state.alertActive });
  sysLog(state.alertActive ? 'alert' : 'info',
    state.alertActive ? 'ALERT MODE ACTIVATED.' : 'Alert mode deactivated.');
  res.json({ alertActive: state.alertActive });
});

// ── POST /api/snapshot ── Save a snapshot sent from browser ────
app.post('/api/snapshot', (req, res) => {
  const { imageData, metadata } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  try {
    // Strip data URI header
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    const ts       = new Date();
    const filename = `snap_${ts.toISOString().replace(/[:.]/g, '-')}_${uuidv4().slice(0, 6)}.jpg`;
    const filepath = path.join(CONFIG.snapshotDir, filename);

    fs.writeFileSync(filepath, buffer);

    const entry = {
      filename,
      url:       `/snapshots/${filename}`,
      timestamp: ts.toISOString(),
      metadata:  metadata || {},
    };

    state.snapshotLog.unshift(entry);
    if (state.snapshotLog.length > CONFIG.maxSnapshotLog) state.snapshotLog.pop();

    // Notify all connected dashboard clients
    io.emit('snapshot_saved', entry);
    sysLog('ok', `Snapshot saved: ${filename}`);
    res.json({ status: 'saved', ...entry });

  } catch (err) {
    sysLog('error', `Snapshot save failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET / ── Serve feed page ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GET /dashboard ── Serve dashboard ──────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  state.connectedClients++;
  io.emit('client_count', state.connectedClients);
  sysLog('info', `Client connected [${socket.id.slice(0, 8)}] · Total: ${state.connectedClients}`);

  // ── Client declares its role ───────────────────────────────
  socket.on('join_room', (room) => {
    socket.join(room);  // 'feed' or 'dashboard'
  });

  // ── Camera feed client sends a new video frame ─────────────
  socket.on('frame', (data) => {
    // data = { imageData: 'base64...', fps: 24.1 }
    state.lastFrame = data.imageData;
    state.fps       = data.fps || 0;
    state.cameraActive = true;

    // Relay frame to all dashboard viewers
    if (CONFIG.frameRelayEnabled) {
      socket.to('dashboard').emit('frame', data);
    }
  });

  // ── Camera stopped ─────────────────────────────────────────
  socket.on('camera_stopped', () => {
    state.cameraActive = false;
    state.fps = 0;
    state.lastFrame = null;
    io.emit('camera_state', { active: false });
    sysLog('warn', 'Camera feed stopped.');
  });

  // ── Camera started ─────────────────────────────────────────
  socket.on('camera_started', () => {
    state.cameraActive = true;
    io.emit('camera_state', { active: true });
    sysLog('ok', 'Camera feed started.');
  });

  // ── New detection event from AI model running in browser ───
  socket.on('detection_event', (payload) => {
    // payload = { detections: [{label, confidence, bbox}], lat, lon, temp, timestamp }
    const { detections, lat, lon, temp, timestamp } = payload;

    if (!detections || detections.length === 0) return;

    detections.forEach((det) => {
      const record = {
        id:         state.detectionLog.length + 1,
        label:      det.label || 'HUMAN',
        confidence: Math.round((det.confidence || 0) * 100),
        bbox:       det.bbox,
        timestamp:  timestamp || new Date().toISOString(),
        lat:        lat || null,
        lon:        lon || null,
        temp:       temp || null,
      };

      state.detectionLog.unshift(record);
      state.totalDetections++;

      // Trim log
      if (state.detectionLog.length > CONFIG.maxDetectionLog) {
        state.detectionLog.pop();
      }

      // Broadcast to all dashboard clients
      io.to('dashboard').emit('new_detection', record);
    });

    // Emit updated total count
    io.emit('detection_count', state.totalDetections);
  });

  // ── GPS update from browser Geolocation API ───────────────
  socket.on('gps_update', (coords) => {
    io.emit('gps_update', coords);
  });

  // ── Detector type update ────────────────────────────────────
  socket.on('detector_type', (type) => {
    state.detectorType = type;
    io.emit('detector_type', type);
  });

  // ── Request current server state (on dashboard connect) ────
  socket.on('request_state', () => {
    socket.emit('server_state', {
      cameraActive:     state.cameraActive,
      alertActive:      state.alertActive,
      totalDetections:  state.totalDetections,
      detectionLog:     state.detectionLog.slice(0, 50),
      snapshotLog:      state.snapshotLog.slice(0, 10),
      systemLog:        state.systemLog.slice(0, 20),
      fps:              state.fps,
      detectorType:     state.detectorType,
    });
  });

  // ── Disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    state.connectedClients = Math.max(0, state.connectedClients - 1);
    io.emit('client_count', state.connectedClients);
    sysLog('info', `Client disconnected [${socket.id.slice(0, 8)}] · Remaining: ${state.connectedClients}`);
  });
});

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════
server.listen(CONFIG.port, CONFIG.host, () => {
  const divider = '═'.repeat(54);
  console.log(`\n╔${divider}╗`);
  console.log(`║        SENTINEL AI — SURVEILLANCE NODE SERVER       ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  📡  URL 1 (Feed)      → http://localhost:${CONFIG.port}/          ║`);
  console.log(`║  🖥   URL 2 (Dashboard) → http://localhost:${CONFIG.port}/dashboard ║`);
  console.log(`║  🌐  LAN Access        → http://<YOUR_IP>:${CONFIG.port}/         ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  Node.js ${process.version} · Socket.io · Express             ║`);
  console.log(`║  Snapshots → ${CONFIG.snapshotDir.slice(-38)}  ║`);
  console.log(`╚${divider}╝\n`);

  sysLog('ok', `Server started on port ${CONFIG.port}.`);
  sysLog('info', `Open browser: http://localhost:${CONFIG.port}/dashboard`);
});

// ── Graceful shutdown ───────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[SENTINEL] Shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('[SENTINEL ERROR]', err.message);
});
