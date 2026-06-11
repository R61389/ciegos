/**
 * esp32.js — Servicio de comunicación ESP32 + HC-SR04
 * Conexión WebSocket (primaria) con fallback HTTP polling
 * Estados: disconnected | connecting | connected | reconnecting
 */

'use strict';

const ESP32Service = (() => {
  const WS_PORT            = 81;
  const HTTP_PORT          = 80;
  const POLL_MS            = 800;
  const WS_TIMEOUT_MS      = 5000;
  const RECONNECT_BASE_MS  = 2000;
  const MAX_RECONNECT      = 12;

  let _ip                = null;
  let _ws                = null;
  let _state             = 'disconnected';
  let _distance          = null;
  let _lastRead          = null;
  let _onData            = null;
  let _onStateChange     = null;
  let _reconnectTimer    = null;
  let _pollTimer         = null;
  let _reconnectAttempts = 0;
  let _usePolling        = false;

  // ─── Conectar ────────────────────────────────
  function connect(ip) {
    if (!ip) return;
    if (_ip === ip && _state === 'connected') return;
    _ip = ip.trim();
    _reconnectAttempts = 0;
    _usePolling = false;
    _cleanUp();
    _tryWS();
    LOG.info(`[ESP32] Conectando a ${_ip}`);
  }

  function _tryWS() {
    if (!_ip) return;
    _setState('connecting');

    try {
      _ws = new WebSocket(`ws://${_ip}:${WS_PORT}`);

      // Timeout si no establece conexión
      const timeout = setTimeout(() => {
        if (_ws && _ws.readyState !== WebSocket.OPEN) {
          LOG.debug('[ESP32] WS timeout → usando HTTP polling');
          _ws.onopen = _ws.onmessage = _ws.onerror = _ws.onclose = null;
          _ws.close();
          _ws = null;
          _startPolling();
        }
      }, WS_TIMEOUT_MS);

      _ws.onopen = () => {
        clearTimeout(timeout);
        _reconnectAttempts = 0;
        _usePolling = false;
        _setState('connected');
        LOG.info('[ESP32] WebSocket conectado');
      };

      _ws.onmessage = (e) => _handleRaw(e.data);

      _ws.onerror = () => {
        clearTimeout(timeout);
        LOG.debug('[ESP32] WS error → usando HTTP polling');
        _ws = null;
        _usePolling = true;
        _startPolling();
      };

      _ws.onclose = () => {
        clearTimeout(timeout);
        if (_state === 'connected' || _state === 'reconnecting') {
          _scheduleReconnect();
        }
      };
    } catch (e) {
      LOG.debug('[ESP32] WS no soportado → HTTP polling');
      _usePolling = true;
      _startPolling();
    }
  }

  // ─── HTTP Polling (fallback) ──────────────────
  function _startPolling() {
    if (_pollTimer) return;
    _setState('connecting');

    const poll = async () => {
      if (!_ip) return;
      try {
        const res = await fetch(`http://${_ip}:${HTTP_PORT}/sensor`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const txt = await res.text();
          _handleRaw(txt.trim());
          if (_state !== 'connected') {
            _reconnectAttempts = 0;
            _setState('connected');
          }
        } else {
          _pollFail();
        }
      } catch (_) {
        _pollFail();
      }
    };

    poll();
    _pollTimer = setInterval(poll, POLL_MS);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function _pollFail() {
    if (_state === 'connected') {
      _scheduleReconnect();
    } else {
      _reconnectAttempts++;
      if (_reconnectAttempts >= MAX_RECONNECT) {
        _setState('disconnected');
        _stopPolling();
        LOG.warn('[ESP32] Sin respuesta, desconectado');
      }
    }
  }

  // ─── Reconexión exponencial ───────────────────
  function _scheduleReconnect() {
    _setState('reconnecting');
    _reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, _reconnectAttempts - 1), 20000);
    LOG.info(`[ESP32] Reconectando en ${(delay / 1000).toFixed(1)}s (intento ${_reconnectAttempts})`);

    _reconnectTimer = setTimeout(() => {
      if (_reconnectAttempts >= MAX_RECONNECT) {
        _setState('disconnected');
        return;
      }
      if (_usePolling) {
        _stopPolling();
        _startPolling();
      } else {
        _tryWS();
      }
    }, delay);
  }

  // ─── Parsear dato del sensor ──────────────────
  function _handleRaw(raw) {
    try {
      let dist = null;

      if (typeof raw === 'string' && raw.startsWith('{')) {
        const obj = JSON.parse(raw);
        dist = obj.distance ?? obj.dist ?? obj.d ?? null;
      } else {
        dist = parseFloat(raw);
      }

      if (dist !== null && !isNaN(dist) && dist >= 0 && dist <= 800) {
        _distance = Math.round(dist * 10) / 10;
        _lastRead = new Date();
        if (_onData) _onData(_distance, _lastRead);
      }
    } catch (_) {
      LOG.debug('[ESP32] Error parseando:', raw);
    }
  }

  // ─── Limpiar conexión ─────────────────────────
  function _cleanUp() {
    clearTimeout(_reconnectTimer);
    _stopPolling();
    if (_ws) {
      _ws.onopen = _ws.onmessage = _ws.onerror = _ws.onclose = null;
      try { _ws.close(); } catch (_) {}
      _ws = null;
    }
  }

  function disconnect() {
    _cleanUp();
    _setState('disconnected');
    _ip = null;
    _distance = null;
    _lastRead = null;
    LOG.info('[ESP32] Desconectado manualmente');
  }

  function _setState(s) {
    if (_state === s) return;
    _state = s;
    LOG.info(`[ESP32] Estado → ${s}`);
    if (_onStateChange) _onStateChange(s);
  }

  // ─── API pública ──────────────────────────────
  return {
    connect,
    disconnect,
    setCallbacks(onData, onStateChange) {
      _onData = onData;
      _onStateChange = onStateChange;
    },
    getState()    { return _state; },
    getDistance() { return _distance; },
    getLastRead() { return _lastRead; },
    getIP()       { return _ip; },
  };
})();
