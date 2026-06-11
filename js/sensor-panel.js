/**
 * sensor-panel.js — Panel de monitoreo ESP32 + HC-SR04
 * Diseño 21st.dev glassmorphism · Animaciones Motion One
 */

'use strict';

// ═══════════════════════════════════════════════
//  EVENT LOG — Registro temporal en memoria
// ═══════════════════════════════════════════════
const EventLog = (() => {
  const MAX = 50;
  let _entries = [];

  function add(distance, lat, lng) {
    const entry = {
      id:       Date.now(),
      time:     new Date(),
      distance,
      lat:      lat ?? null,
      lng:      lng ?? null,
    };
    _entries.unshift(entry);
    if (_entries.length > MAX) _entries.pop();
    return entry;
  }

  function getAll()  { return [..._entries]; }
  function clear()   { _entries = []; }
  function count()   { return _entries.length; }

  return { add, getAll, clear, count };
})();


// ═══════════════════════════════════════════════
//  SENSOR ALERTS — Alertas por distancia
// ═══════════════════════════════════════════════
const SensorAlerts = (() => {
  let _audioCtx      = null;
  let _prevLevel     = 0;
  let _alertTimer    = null;
  let _soundCooldown = false;

  function _ctx() {
    if (!_audioCtx) {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    return _audioCtx;
  }

  function _beep(freq, dur, gain = 0.35) {
    const ctx = _ctx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.frequency.value = freq;
      g.gain.setValueAtTime(gain, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch (_) {}
  }

  function _alarmSound() {
    if (_soundCooldown) return;
    _soundCooldown = true;
    _beep(1320, 0.08);
    setTimeout(() => _beep(1320, 0.08), 140);
    setTimeout(() => _beep(990, 0.15), 300);
    setTimeout(() => { _soundCooldown = false; }, 1800);
  }

  function check(distance) {
    if (distance === null || distance === undefined) return 0;

    let level = 0;
    if (distance < 30)       level = 3; // CRÍTICO → sonido + vibración
    else if (distance < 50)  level = 2; // ALERTA → vibración
    else if (distance < 100) level = 1; // AVISO → visual

    if (level > 0 && level >= _prevLevel) {
      _trigger(level, distance);
    }
    _prevLevel = level;
    return level;
  }

  function _trigger(level, distance) {
    clearTimeout(_alertTimer);

    const overlay = document.getElementById('esp-alert');
    if (overlay) {
      const msg = overlay.querySelector('.esp-alert-msg');
      const d   = Math.round(distance);

      if (msg) {
        msg.textContent =
          level === 3 ? `⚠ PELIGRO — Obstáculo a ${d} cm` :
          level === 2 ? `⚡ PRECAUCIÓN — Obstáculo a ${d} cm` :
                        `◉ AVISO — Obstáculo a ${d} cm`;
      }

      overlay.className = `esp-alert esp-alert-l${level} on`;

      if (typeof Motion !== 'undefined') {
        Motion.animate(overlay, { y: ['-120%', '0%'], opacity: [0, 1] }, { duration: 0.3, easing: [0.34, 1.56, 0.64, 1] });
      }

      _alertTimer = setTimeout(() => {
        if (typeof Motion !== 'undefined') {
          Motion.animate(overlay, { y: ['0%', '-120%'], opacity: [1, 0] }, { duration: 0.25 })
            .then(() => overlay.classList.remove('on'));
        } else {
          overlay.classList.remove('on');
        }
      }, 3000);
    }

    // Vibración
    if (level >= 2 && navigator.vibrate) {
      navigator.vibrate(level === 3 ? [200, 80, 200, 80, 200] : [180]);
    }

    // Sonido crítico
    if (level === 3) _alarmSound();
  }

  return { check };
})();


// ═══════════════════════════════════════════════
//  SENSOR PANEL — UI principal del módulo
// ═══════════════════════════════════════════════
const SensorPanel = (() => {
  const $ = id => document.getElementById(id);

  let _isOpen      = false;
  let _activeTab   = 'monitor';
  let _gpsInterval = null;

  // ─── Init ─────────────────────────────────────
  function init() {
    // Callbacks ESP32
    ESP32Service.setCallbacks(_onData, _onStateChange);

    // Botones
    $('esp-fab')?.addEventListener('click', toggle);
    $('esp-close')?.addEventListener('click', close);
    $('esp-connect-btn')?.addEventListener('click', _onConnect);
    $('esp-disconnect-btn')?.addEventListener('click', _onDisconnect);

    $('esp-ip-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') _onConnect();
    });

    // Tabs
    document.querySelectorAll('.esp-tab').forEach(tab => {
      tab.addEventListener('click', () => _switchTab(tab.dataset.tab));
    });

    // GPS ticker en tab mapa
    _gpsInterval = setInterval(_updateMapTab, 1500);

    LOG.info('[SensorPanel] Inicializado');
  }

  // ─── Conexión ─────────────────────────────────
  function _onConnect() {
    const ip = $('esp-ip-input')?.value?.trim();
    if (!ip) {
      _shakeInput();
      return;
    }
    $('esp-connect-btn').disabled = true;
    $('esp-connect-btn').textContent = 'Conectando...';
    ESP32Service.connect(ip);
    setTimeout(() => {
      $('esp-connect-btn').disabled = false;
      $('esp-connect-btn').textContent = 'Conectar';
    }, 3000);
  }

  function _onDisconnect() {
    ESP32Service.disconnect();
  }

  function _shakeInput() {
    const inp = $('esp-ip-input');
    if (!inp) return;
    if (typeof Motion !== 'undefined') {
      Motion.animate(inp, { x: [0, -8, 8, -6, 6, 0] }, { duration: 0.4 });
    }
  }

  // ─── Datos del sensor ─────────────────────────
  function _onData(distance, time) {
    _updateDistanceDisplay(distance, time);
    EventLog.add(distance, AppState.lat, AppState.lng);
    _updateLogBadge();

    const level = SensorAlerts.check(distance);
    _updateFAB(level, ESP32Service.getState());
    _updateMapOverlay(distance);
    _updateMapTab();

    // Actualizar contadores visibles
    const evtCount = document.getElementById('esp-events-count');
    if (evtCount) evtCount.textContent = EventLog.count();

    const dualSensor = document.getElementById('esp-dual-sensor');
    if (dualSensor) {
      dualSensor.textContent = `${distance} cm`;
      dualSensor.className = `esp-dual-value ${
        distance < 30 ? 'crit' : distance < 50 ? 'warn' : distance < 100 ? 'caution' : ''
      }`;
    }

    const mapSensorDist = document.getElementById('esp-map-sensor-dist');
    if (mapSensorDist) {
      mapSensorDist.textContent = `${distance} cm`;
      mapSensorDist.className = `esp-info-card-value ${
        distance < 30 ? 'crit' : distance < 50 ? 'warn' : distance < 100 ? 'caution' : 'ok'
      }`;
    }

    if (_isOpen && _activeTab === 'registro') {
      _renderLog();
    }
  }

  function _onStateChange(state) {
    _updateBadge(state);
    _updateFAB(0, state);

    if (state === 'disconnected' || state === 'reconnecting') {
      _updateDistanceDisplay(null, null);
      _updateMapOverlay(null);
    }
  }

  // ─── Display distancia (gauge + número) ───────
  function _updateDistanceDisplay(dist, time) {
    const numEl  = $('esp-dist-num');
    const timeEl = $('esp-last-time');
    const stEl   = $('esp-sensor-state');

    if (dist === null) {
      if (numEl) numEl.textContent = '--';
      if (stEl)  { stEl.textContent = 'Sin datos'; stEl.className = 'esp-sensor-state'; }
      _setGauge(0, null);
      return;
    }

    // Animar número
    if (numEl) {
      const prev = parseFloat(numEl.dataset.prev || numEl.textContent) || 0;
      numEl.dataset.prev = dist;
      _tweenNumber(numEl, prev, dist, 380);
    }

    if (timeEl && time) {
      timeEl.textContent = _fmtTime(time);
    }

    if (stEl) {
      const [label, cls] =
        dist < 30  ? ['⚠ CRÍTICO',   'crit'] :
        dist < 50  ? ['! ALERTA',    'warn'] :
        dist < 100 ? ['◉ PRECAUCIÓN','caution'] :
                     ['✓ Libre',     'ok'];
      stEl.textContent = label;
      stEl.className = `esp-sensor-state ${cls}`;
    }

    // Gauge 0-400cm
    const pct = Math.max(0, Math.min(100, (dist / 400) * 100));
    _setGauge(pct, dist);
  }

  // ─── Gauge SVG circular ───────────────────────
  function _setGauge(pct, dist) {
    const arc   = $('esp-gauge-fill');
    const glow  = $('esp-gauge-glow');
    if (!arc) return;

    const CIRC = 2 * Math.PI * 40; // ≈ 251.33
    const offset = CIRC - (pct / 100) * CIRC;

    const color =
      !dist      ? 'rgba(0,200,255,0.2)' :
      dist < 30  ? '#ff4444' :
      dist < 50  ? '#ff8822' :
      dist < 100 ? '#ffd060' : '#00ff88';

    if (typeof Motion !== 'undefined') {
      Motion.animate(arc, {
        strokeDashoffset: [null, offset],
        stroke: color,
      }, { duration: 0.35, easing: 'ease-out' });
    } else {
      arc.style.strokeDashoffset = offset;
      arc.style.stroke = color;
    }

    if (glow) glow.style.color = color;
  }

  // ─── Tweening numérico ────────────────────────
  function _tweenNumber(el, from, to, dur) {
    const start = performance.now();
    const step  = (now) => {
      const p    = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const val  = from + (to - from) * ease;
      el.textContent = to % 1 !== 0 ? val.toFixed(1) : Math.round(val);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ─── Badge de conexión ─────────────────────────
  function _updateBadge(state) {
    const el = $('esp-conn-badge');
    if (!el) return;

    const MAP = {
      disconnected: ['Desconectado', 'badge-disc'],
      connecting:   ['Conectando…',  'badge-conn'],
      connected:    ['Conectado',    'badge-ok'],
      reconnecting: ['Reconectando…','badge-warn'],
    };

    const [label, cls] = MAP[state] || [state, ''];
    el.textContent = label;
    el.className   = `esp-conn-badge ${cls}`;

    if (state === 'connected' && typeof Motion !== 'undefined') {
      Motion.animate(el, { scale: [1, 1.15, 1] }, { duration: 0.4, easing: [0.34, 1.56, 0.64, 1] });
    }
  }

  // ─── FAB flotante ────────────────────────────
  function _updateFAB(alertLevel, state) {
    const fab = $('esp-fab');
    const dot = $('esp-fab-dot');
    if (!fab) return;

    fab.dataset.alert = alertLevel;
    if (dot) dot.className = `esp-fab-dot ${
      state === 'connected'    ? 'ok' :
      state === 'reconnecting' ? 'warn' : 'disc'
    }`;

    // Pulso de alerta en el FAB
    if (alertLevel >= 2 && typeof Motion !== 'undefined') {
      Motion.animate(fab, { scale: [1, 1.18, 1] }, { duration: 0.3 });
    }
  }

  // ─── Map overlay (sobre el mapa Leaflet) ──────
  function _updateMapOverlay(dist) {
    const el  = $('esp-map-overlay');
    const txt = $('esp-map-overlay-dist');
    if (!el) return;

    if (dist === null) {
      el.classList.remove('on');
      return;
    }

    if (!el.classList.contains('on')) {
      el.classList.add('on');
      if (typeof Motion !== 'undefined') {
        Motion.animate(el, { opacity: [0, 1], x: [20, 0] }, { duration: 0.3 });
      }
    }

    if (txt) {
      txt.textContent = `${Math.round(dist)} cm`;
      txt.className   = `esp-map-overlay-dist ${
        dist < 30 ? 'crit' : dist < 50 ? 'warn' : dist < 100 ? 'caution' : 'ok'
      }`;
    }
  }

  // ─── Tab: Mapa ────────────────────────────────
  function _updateMapTab() {
    const coordsEl  = $('esp-gps-coords');
    const sensorEl  = $('esp-map-sensor-dist');
    const descEl    = $('esp-map-desc');

    if (coordsEl) {
      if (AppState.lat && AppState.lng) {
        coordsEl.textContent = `${AppState.lat.toFixed(5)}, ${AppState.lng.toFixed(5)}`;
      } else {
        coordsEl.textContent = 'Obteniendo GPS…';
      }
    }

    const dist = ESP32Service.getDistance();
    if (sensorEl) {
      sensorEl.textContent = dist !== null ? `${dist} cm` : '-- cm';
      sensorEl.className = `esp-map-card-value ${
        dist === null ? '' :
        dist < 30    ? 'crit' :
        dist < 50    ? 'warn' :
        dist < 100   ? 'caution' : 'ok'
      }`;
    }

    if (descEl && dist !== null) {
      descEl.textContent =
        dist < 30  ? `⚠ Obstáculo muy cercano (${dist} cm) — ¡Detente!` :
        dist < 50  ? `⚡ Objeto a ${dist} cm — Precaución al avanzar` :
        dist < 100 ? `◉ Objeto a ${dist} cm — Zona de atención` :
                     `✓ Camino libre — ${dist} cm sin obstáculos`;
    }
  }

  // ─── Tab: Registro ────────────────────────────
  function _renderLog() {
    const list = $('esp-log-list');
    if (!list) return;

    const entries = EventLog.getAll().slice(0, 25);

    if (entries.length === 0) {
      list.innerHTML = `<div class="esp-log-empty">Sin registros aún.<br>Conecta el ESP32 para comenzar.</div>`;
      return;
    }

    list.innerHTML = entries.map(e => {
      const cls =
        e.distance < 30  ? 'crit' :
        e.distance < 50  ? 'warn' :
        e.distance < 100 ? 'caution' : '';

      const gps = e.lat
        ? `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}`
        : '—';

      return `<div class="esp-log-row ${cls}">
        <div class="esp-log-left">
          <span class="esp-log-dist">${e.distance} cm</span>
          <span class="esp-log-time">${_fmtTime(e.time)}</span>
        </div>
        <span class="esp-log-gps">${gps}</span>
      </div>`;
    }).join('');
  }

  function _updateLogBadge() {
    const b = $('esp-log-badge');
    if (b) {
      const n = EventLog.count();
      b.textContent = n > 99 ? '99+' : n;
      b.style.display = n > 0 ? 'flex' : 'none';
    }
  }

  // ─── Tabs ─────────────────────────────────────
  function _switchTab(tabId) {
    _activeTab = tabId;

    document.querySelectorAll('.esp-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.esp-tab-content').forEach(c => {
      const isActive = c.id === `esp-tab-${tabId}`;
      c.classList.toggle('active', isActive);

      if (isActive && typeof Motion !== 'undefined') {
        Motion.animate(c, { opacity: [0, 1], y: [8, 0] }, { duration: 0.25 });
      }
    });

    if (tabId === 'registro') _renderLog();
    if (tabId === 'mapa')     _updateMapTab();
  }

  // ─── Panel open / close ───────────────────────
  function open() {
    if (_isOpen) return;
    _isOpen = true;

    const panel = $('esp-panel');
    if (!panel) return;
    panel.classList.add('open');

    if (typeof Motion !== 'undefined') {
      Motion.animate(panel,
        { y: ['100%', '0%'], opacity: [0.6, 1] },
        { duration: 0.42, easing: [0.32, 0, 0.25, 1.1] }
      );
    }

    if (_activeTab === 'registro') _renderLog();
    if (_activeTab === 'mapa')     _updateMapTab();
  }

  function close() {
    if (!_isOpen) return;
    _isOpen = false;

    const panel = $('esp-panel');
    if (!panel) return;

    if (typeof Motion !== 'undefined') {
      Motion.animate(panel,
        { y: ['0%', '100%'], opacity: [1, 0] },
        { duration: 0.32, easing: [0.4, 0, 1, 1] }
      ).then(() => panel.classList.remove('open'));
    } else {
      panel.classList.remove('open');
    }
  }

  function toggle() { _isOpen ? close() : open(); }

  // ─── Helpers ──────────────────────────────────
  function _fmtTime(d) {
    if (!d) return '--:--:--';
    return d.toLocaleTimeString('es', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // Exponer renderLog para el botón limpiar externo
  SensorPanel._renderLogExt = _renderLog;

  return { init, open, close, toggle, _renderLogExt: _renderLog };
})();
