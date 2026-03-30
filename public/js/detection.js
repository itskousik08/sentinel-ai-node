/**
 * SENTINEL AI — Detection Engine (detection.js)
 * Runs entirely in the browser.
 *
 * Responsibilities:
 *   1. Access camera via getUserMedia
 *   2. Load TF.js COCO-SSD model
 *   3. Run inference every N frames
 *   4. Draw tactical HUD overlay on canvas
 *   5. Emit detection events + frames to server via Socket.io
 *   6. Get GPS via browser Geolocation API
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
//  DETECTION ENGINE CLASS
// ═══════════════════════════════════════════════════════════════
class SentinelEngine {
  constructor(options = {}) {
    this.opts = {
      videoEl:           options.videoEl,           // <video> element
      canvasEl:          options.canvasEl,          // <canvas> overlay element
      onDetection:       options.onDetection || (() => {}),
      onFrame:           options.onFrame    || (() => {}),
      onStatus:          options.onStatus   || (() => {}),
      onLog:             options.onLog      || (() => {}),
      detectionInterval: options.detectionInterval || 4,  // every N frames
      confidence:        options.confidence        || 0.45,
      frameWidth:        options.frameWidth        || 640,
      frameHeight:       options.frameHeight       || 480,
      jpegQuality:       options.jpegQuality       || 0.70,
    };

    this.model         = null;
    this.running       = false;
    this.frameCount    = 0;
    this.fps           = 0;
    this.fpsTimer      = Date.now();
    this.fpsFrames     = 0;
    this.lastDetections= [];
    this.gps           = { lat: null, lon: null };
    this.temperature   = this._genTemp();
    this.animFrame     = null;
    this.stream        = null;
    this.detectorType  = 'TF.js COCO-SSD';
  }

  // ── Simulated temperature (replace with real sensor if available) ──
  _genTemp() {
    return (28 + Math.random() * 8 - 2).toFixed(1);
  }

  // ── Log helper ──────────────────────────────────────────────
  _log(level, msg) {
    console.log(`[SENTINEL:${level.toUpperCase()}] ${msg}`);
    this.opts.onLog(level, msg);
  }

  // ── Initialize GPS via browser Geolocation API ──────────────
  _initGPS() {
    if (!navigator.geolocation) {
      this._log('warn', 'Geolocation not available — using simulation.');
      // Simulate GPS drift from Delhi
      this.gps = { lat: 28.6139 + (Math.random() - 0.5) * 0.01, lon: 77.2090 + (Math.random() - 0.5) * 0.01 };
      setInterval(() => {
        this.gps.lat += (Math.random() - 0.5) * 0.00005;
        this.gps.lon += (Math.random() - 0.5) * 0.00005;
      }, 3000);
      return;
    }

    const watchOpts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 };
    navigator.geolocation.watchPosition(
      (pos) => {
        this.gps = {
          lat: parseFloat(pos.coords.latitude.toFixed(6)),
          lon: parseFloat(pos.coords.longitude.toFixed(6)),
        };
        this._log('ok', `GPS fix: ${this.gps.lat}, ${this.gps.lon}`);
      },
      (err) => {
        this._log('warn', `GPS error (${err.code}): using simulated position.`);
        this.gps = { lat: 28.6139, lon: 77.2090 };
      },
      watchOpts
    );
  }

  // ── Load TF.js COCO-SSD model ──────────────────────────────
  async _loadModel() {
    this._log('info', 'Loading TF.js COCO-SSD model…');
    this.opts.onStatus('LOADING MODEL…');

    try {
      // Wait for cocoSsd to be available on window
      if (typeof cocoSsd === 'undefined') {
        throw new Error('cocoSsd not loaded — check script tags');
      }
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      this.detectorType = 'TF.js COCO-SSD (lite)';
      this._log('ok', 'COCO-SSD model loaded successfully.');
      this.opts.onStatus('MODEL READY');
      return true;
    } catch (err) {
      this._log('warn', `COCO-SSD failed: ${err.message}. Using motion fallback.`);
      this.model = null;
      this.detectorType = 'Motion Detector (fallback)';
      this.opts.onStatus('FALLBACK MODE');
      return false;
    }
  }

  // ── Open camera via getUserMedia ────────────────────────────
  async _openCamera() {
    const constraints = {
      video: {
        facingMode:  { ideal: 'environment' }, // Prefer rear camera
        width:       { ideal: this.opts.frameWidth },
        height:      { ideal: this.opts.frameHeight },
        frameRate:   { ideal: 15, max: 30 },
      },
      audio: false,
    };

    this._log('info', 'Requesting camera access…');
    this.opts.onStatus('OPENING CAMERA…');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.opts.videoEl.srcObject = this.stream;
      await this.opts.videoEl.play();
      this._log('ok', 'Camera opened successfully.');
      this.opts.onStatus('CAMERA ACTIVE');
      return true;
    } catch (err) {
      this._log('error', `Camera access denied: ${err.message}`);
      this.opts.onStatus('CAMERA ERROR');
      throw err;
    }
  }

  // ── Run detection on current video frame ────────────────────
  async _runDetection() {
    if (!this.opts.videoEl || this.opts.videoEl.readyState < 2) return [];
    if (!this.model) return this._motionFallback();

    try {
      const predictions = await this.model.detect(this.opts.videoEl);
      // Filter: only "person" class above confidence threshold
      return predictions
        .filter(p => p.class === 'person' && p.score >= this.opts.confidence)
        .map(p => ({
          label:      'HUMAN',
          confidence: p.score,
          bbox:       p.bbox, // [x, y, width, height]
        }));
    } catch (err) {
      return [];
    }
  }

  // ── Motion fallback detector (pixel diff) ───────────────────
  _motionFallback() {
    // Lightweight placeholder — returns empty (real motion detection
    // would compare frame buffers). Can be extended later.
    return [];
  }

  // ── Draw full tactical HUD on canvas ────────────────────────
  _drawHUD(ctx, detections, w, h) {
    ctx.clearRect(0, 0, w, h);

    const now = new Date();
    const ts  = now.toLocaleString('en-GB', { hour12: false }).replace(',', '');
    const lat = this.gps.lat ? this.gps.lat.toFixed(5) : '??';
    const lon = this.gps.lon ? this.gps.lon.toFixed(5) : '??';

    // ── Semi-transparent top + bottom bars ─────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, w, 38);
    ctx.fillRect(0, h - 34, w, 34);

    // ── Top-left corner bracket ─────────────────────────────
    const drawBracket = (x, y, size, flip) => {
      const sx = flip ? -1 : 1;
      const sy = flip ? -1 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sx, sy);
      ctx.strokeStyle = '#ffb700';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, size); ctx.lineTo(0, 0); ctx.lineTo(size, 0);
      ctx.stroke();
      ctx.restore();
    };
    const bSz = 20;
    drawBracket(8, 8, bSz, false);           // top-left
    drawBracket(w - 8, 8, bSz, false);       // top-right (will be mirrored below)
    ctx.save();
    ctx.translate(w - 8, 8);
    ctx.scale(-1, 1);
    ctx.strokeStyle = '#ffb700'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, bSz); ctx.lineTo(0, 0); ctx.lineTo(bSz, 0); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(8, h - 8);
    ctx.scale(1, -1);
    ctx.strokeStyle = '#ffb700'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, bSz); ctx.lineTo(0, 0); ctx.lineTo(bSz, 0); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(w - 8, h - 8);
    ctx.scale(-1, -1);
    ctx.strokeStyle = '#ffb700'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, bSz); ctx.lineTo(0, 0); ctx.lineTo(bSz, 0); ctx.stroke();
    ctx.restore();

    // ── Top bar text ────────────────────────────────────────
    ctx.font      = '700 11px "Orbitron", monospace';
    ctx.fillStyle = '#ffb700';
    ctx.textAlign = 'left';
    ctx.shadowColor  = 'rgba(255,183,0,0.6)';
    ctx.shadowBlur   = 6;
    ctx.fillText('▲ SENTINEL AI', 14, 24);

    ctx.font      = '10px "Courier Prime", monospace';
    ctx.fillStyle = '#998840';
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.fillText(ts, w / 2, 24);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#887730';
    ctx.fillText(`FPS:${this.fps.toFixed(1)}`, w - 14, 24);

    // ── Bottom bar text ─────────────────────────────────────
    ctx.font      = '9px "Courier Prime", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#00c8cc';
    ctx.shadowColor = 'rgba(0,200,210,0.5)';
    ctx.shadowBlur  = 4;
    ctx.fillText(`GPS ${lat},${lon}`, 14, h - 12);

    ctx.textAlign  = 'center';
    ctx.fillStyle  = '#cc9900';
    ctx.shadowBlur = 0;
    ctx.fillText(`${this.temperature}°C`, w / 2, h - 12);

    const hasTargets = detections.length > 0;
    ctx.textAlign  = 'right';
    ctx.fillStyle  = hasTargets ? '#ff4444' : '#559944';
    ctx.shadowColor = hasTargets ? 'rgba(255,44,44,0.5)' : 'rgba(50,180,80,0.5)';
    ctx.shadowBlur  = hasTargets ? 8 : 4;
    ctx.fillText(`TARGETS:${detections.length}`, w - 14, h - 12);
    ctx.shadowBlur  = 0;

    // ── Detection bounding boxes ─────────────────────────────
    detections.forEach((det, i) => {
      const [bx, by, bw, bh] = det.bbox;
      const x1 = bx, y1 = by, x2 = bx + bw, y2 = by + bh;

      // Outer box
      ctx.strokeStyle = 'rgba(255,65,65,0.85)';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(x1, y1, bw, bh);

      // Animated corner accents
      const ca = 12;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 2;
      [[x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1]]
        .forEach(([cx, cy, dx, dy]) => {
          ctx.beginPath();
          ctx.moveTo(cx, cy + dy * ca); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * ca, cy);
          ctx.stroke();
        });

      // Label pill
      const labelText = `${det.label} ${(det.confidence * 100).toFixed(0)}%`;
      ctx.font = '700 10px "Courier Prime", monospace';
      const tw = ctx.measureText(labelText).width;
      const pillY = Math.max(y1 - 4, 18);
      ctx.fillStyle = 'rgba(200,30,30,0.82)';
      ctx.fillRect(x1, pillY - 14, tw + 12, 18);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign  = 'left';
      ctx.shadowBlur = 0;
      ctx.fillText(labelText, x1 + 6, pillY);

      // Target ID badge
      ctx.font      = '9px "Courier Prime", monospace';
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.textAlign  = 'left';
      ctx.fillText(`T${String(i + 1).padStart(2, '0')}`, x1 + 4, y2 - 5);
    });

    // ── Alert mode flash ─────────────────────────────────────
    if (window._sentinelAlert) {
      ctx.strokeStyle = 'rgba(255,40,40,0.6)';
      ctx.lineWidth   = 3;
      ctx.strokeRect(2, 2, w - 4, h - 4);
    }
  }

  // ── Main render + detect loop ────────────────────────────────
  _loop() {
    if (!this.running) return;

    const video  = this.opts.videoEl;
    const canvas = this.opts.canvasEl;
    const ctx    = canvas.getContext('2d');
    const w      = canvas.width  = video.videoWidth  || this.opts.frameWidth;
    const h      = canvas.height = video.videoHeight || this.opts.frameHeight;

    // Draw video frame onto canvas
    ctx.drawImage(video, 0, 0, w, h);

    this.frameCount++;
    this.fpsFrames++;

    // FPS calculation
    const now = Date.now();
    if (now - this.fpsTimer >= 1000) {
      this.fps       = this.fpsFrames / ((now - this.fpsTimer) / 1000);
      this.fpsFrames = 0;
      this.fpsTimer  = now;
      // Update temperature periodically
      this.temperature = this._genTemp();
    }

    // Run AI detection every N frames
    if (this.frameCount % this.opts.detectionInterval === 0) {
      this._runDetection().then((detections) => {
        this.lastDetections = detections;

        if (detections.length > 0) {
          this.opts.onDetection({
            detections,
            lat:       this.gps.lat,
            lon:       this.gps.lon,
            temp:      this.temperature,
            timestamp: new Date().toISOString(),
          });
        }
      });
    }

    // Draw HUD overlay
    this._drawHUD(ctx, this.lastDetections, w, h);

    // Emit frame to server every ~5 frames for dashboard relay
    if (this.frameCount % 5 === 0) {
      try {
        const frameData = canvas.toDataURL('image/jpeg', this.opts.jpegQuality);
        this.opts.onFrame({ imageData: frameData, fps: this.fps });
      } catch (e) { /* cross-origin canvas taint — ignore */ }
    }

    this.animFrame = requestAnimationFrame(() => this._loop());
  }

  // ── Public: Start the engine ────────────────────────────────
  async start() {
    if (this.running) return;
    this._initGPS();
    await this._loadModel();
    await this._openCamera();
    this.running    = true;
    this.frameCount = 0;
    this.fps        = 0;
    this._loop();
    this._log('ok', 'Detection engine running.');
  }

  // ── Public: Stop the engine ─────────────────────────────────
  stop() {
    this.running = false;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    const canvas = this.opts.canvasEl;
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._log('warn', 'Detection engine stopped.');
  }
}

// Export for use in page scripts
window.SentinelEngine = SentinelEngine;
