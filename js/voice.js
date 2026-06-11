/**
 * voice.js — Módulo de voz VozUrbana
 * Síntesis: ElevenLabs (primario) → Web Speech API (fallback)
 * Reconocimiento: Web Speech API
 * Anti-bucle garantizado, cola de mensajes, reconexión automática
 */

'use strict';

const Voice = (() => {

  // ─── Estado interno ───────────────────────────
  let _speaking   = false;
  let _micActive  = false;
  let _recognition= null;
  let _synthVoice = null;
  let _waveInterval = null;
  let _restartTimer = null;
  let _mode       = 'free';    // 'dest' | 'confirm' | 'free' | 'wake' | 'off'
  let _onResult   = null;      // callback cuando el usuario habla
  let _speakQueue = [];        // cola de mensajes de voz
  let _processingQueue = false;
  let _micRestarts = 0;        // contador de reinicios
  const MAX_RESTARTS = 10;

  // ─── Constantes ───────────────────────────────
  const SILENCE_AFTER_SPEAK = 800; // ms de silencio tras hablar antes de reactivar mic

  // ─── Cargar mejor voz disponible ──────────────
  function _loadVoice() {
    const voices = window.speechSynthesis?.getVoices() || [];
    const prefs = [
      v => v.name.includes('Google') && v.lang.startsWith('es'),
      v => v.name.toLowerCase().includes('sabina'),
      v => v.name.toLowerCase().includes('paulina'),
      v => v.name.toLowerCase().includes('monica'),
      v => v.name.toLowerCase().includes('conchita'),
      v => v.lang === 'es-419',
      v => v.lang === 'es-MX',
      v => v.lang === 'es-ES',
      v => v.lang.startsWith('es'),
    ];
    for (const pref of prefs) {
      const found = voices.find(pref);
      if (found) { _synthVoice = found; break; }
    }
    if (_synthVoice) {
      LOG.info(`Voz seleccionada: ${_synthVoice.name} (${_synthVoice.lang})`);
    }
  }

  if (window.speechSynthesis) {
    _loadVoice();
    window.speechSynthesis.onvoiceschanged = _loadVoice;
  }

  // ─── Cola de síntesis ─────────────────────────
  function _processQueue() {
    if (_processingQueue || _speakQueue.length === 0) return;
    _processingQueue = true;
    const { text, cb } = _speakQueue.shift();
    _doSpeak(text, () => {
      _processingQueue = false;
      if (cb) cb();
      _processQueue();
    });
  }

  function _doSpeak(text, cb) {
    if (!text) { _speaking = false; if (cb) cb(); return; }

    LOG.info(`🔊 Hablando: "${text.slice(0, 50)}…"`);
    _speaking = true;
    _pauseMic();
    UI.startWave();
    UI.announce(text);

    // ── ElevenLabs (primario) ──
    if (typeof ElevenLabs !== 'undefined' && ElevenLabs.isConfigured()) {
      _doSpeakEL(text, cb);
      return;
    }

    // ── Web Speech API (fallback) ──
    _doSpeakNative(text, cb);
  }

  // ElevenLabs TTS — async con fallback
  async function _doSpeakEL(text, cb) {
    const done = () => {
      _speaking = false;
      UI.stopWave();
      setTimeout(() => {
        if (cb) cb();
        _resumeMic();
      }, SILENCE_AFTER_SPEAK);
    };

    const ok = await ElevenLabs.speak(text, null, done);
    if (!ok) {
      LOG.warn('ElevenLabs falló → Web Speech API');
      _doSpeakNative(text, cb);
    }
  }

  // Web Speech API nativo
  function _doSpeakNative(text, cb) {
    if (!window.speechSynthesis) {
      _speaking = false;
      UI.stopWave();
      if (cb) cb();
      return;
    }

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang   = 'es';
    u.rate   = 1.0;
    u.pitch  = 1.1;
    u.volume = 1.0;
    if (_synthVoice) u.voice = _synthVoice;

    u.onstart = () => { _speaking = true; UI.startWave(); };

    u.onend = () => {
      LOG.info('🔊 Fin de síntesis nativa');
      _speaking = false;
      UI.stopWave();
      setTimeout(() => {
        if (cb) cb();
        _resumeMic();
      }, SILENCE_AFTER_SPEAK);
    };

    u.onerror = (e) => {
      LOG.warn('SpeechSynthesis error:', e.error);
      _speaking = false;
      UI.stopWave();
      setTimeout(() => {
        if (cb) cb();
        _resumeMic();
      }, SILENCE_AFTER_SPEAK);
    };

    // Workaround Chrome ~15s pause bug
    const keepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      } else { clearInterval(keepAlive); }
    }, 10000);

    setTimeout(() => window.speechSynthesis.speak(u), 60);
  }

  // ─── Pausar/reanudar micrófono ────────────────
  function _pauseMic() {
    if (_recognition) {
      try { _recognition.stop(); } catch (_) {}
    }
    _micActive = false;
  }

  function _resumeMic() {
    if (_mode === 'off') return;
    if (_speaking) return;
    _startMic(_mode);
  }

  // ─── Iniciar reconocimiento ───────────────────
  function _startMic(mode) {
    if (_speaking) {
      LOG.debug('Mic bloqueado — IA hablando');
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      LOG.warn('SpeechRecognition no disponible — usa Chrome');
      UI.setMicStatus('Chrome requerido para voz', false);
      return;
    }

    // Evitar instancias múltiples
    if (_recognition) {
      try { _recognition.stop(); } catch (_) {}
      _recognition = null;
    }

    _mode = mode;
    const r = new SR();
    r.lang            = 'es-419'; // español latinoamericano
    r.interimResults  = false;
    r.maxAlternatives = 5;
    r.continuous      = false;   // false evita el bug de Chrome que no para

    // Capturar el modo al momento de crear el reconocedor
    const capturedMode = mode;

    r.onresult = (ev) => {
      if (_speaking) {
        LOG.debug('Ignorado — IA hablando');
        return;
      }
      // Tomar resultado con mayor confianza
      let best = '', bestConf = 0;
      for (let i = 0; i < ev.results[0].length; i++) {
        if (ev.results[0][i].confidence > bestConf) {
          bestConf = ev.results[0][i].confidence;
          best = ev.results[0][i].transcript.trim();
        }
      }
      if (!best) return;

      LOG.info(`🎤 Escuché: "${best}" (conf: ${bestConf.toFixed(2)}, modo: ${capturedMode})`);
      UI.setMicStatus(`Escuché: ${best}`, true);
      _micRestarts = 0;

      // Usar el modo capturado al crear, no el modo actual
      if (_onResult) _onResult(best, capturedMode);
    };

    r.onerror = (err) => {
      LOG.warn('Mic error:', err.error);
      _micActive = false;

      switch (err.error) {
        case 'not-allowed':
        case 'permission-denied':
          UI.setMicStatus('⚠ Permite el micrófono en Chrome', false);
          _mode = 'off';
          return;
        case 'no-speech':
          // Normal — reiniciar silenciosamente
          setTimeout(() => _restartIfNeeded(), 500);
          return;
        case 'aborted':
        case 'audio-capture':
          setTimeout(() => _restartIfNeeded(), 800);
          return;
        case 'network':
          setTimeout(() => _restartIfNeeded(), 2000);
          return;
        default:
          setTimeout(() => _restartIfNeeded(), 1000);
      }
    };

    r.onend = () => {
      _micActive = false;
      LOG.debug('Mic ended');
      // Reiniciar automáticamente si no está hablando
      if (!_speaking && _mode !== 'off') {
        setTimeout(() => _restartIfNeeded(), 400);
      }
    };

    r.onstart = () => {
      _micActive = true;
      _micRestarts = 0;
      const labels = {
        dest:    'Di a dónde quieres ir...',
        confirm: 'Di sí o no...',
        free:    'Escuchando...',
        wake:    'Listo para escuchar...',
      };
      UI.setMicStatus(labels[mode] || 'Escuchando...', true);
      LOG.debug(`Mic iniciado en modo: ${mode}`);
    };

    _recognition = r;
    _micActive = false;

    try {
      r.start();
    } catch (e) {
      LOG.warn('Error al iniciar mic:', e.message);
      setTimeout(() => _restartIfNeeded(), 1200);
    }
  }

  function _restartIfNeeded() {
    if (_speaking || _mode === 'off') return;
    if (_micRestarts >= MAX_RESTARTS) {
      LOG.warn(`Mic: máximo de reinicios (${MAX_RESTARTS}) alcanzado`);
      UI.setMicStatus('⚠ Micrófono inestable — recarga la página', false);
      // Resetear contador y reintentar después de 5s
      _micRestarts = 0;
      setTimeout(() => _startMic(_mode), 5000);
      return;
    }
    _micRestarts++;
    LOG.debug(`Reiniciando mic en modo "${_mode}" (intento ${_micRestarts})`);
    _startMic(_mode);
  }

  // ─── API pública ──────────────────────────────
  return {

    /**
     * Hablar un texto. Se encola si hay otro mensaje en curso.
     * @param {string} text - Texto a hablar
     * @param {Function} [cb] - Callback cuando termine
     */
    speak(text, cb) {
      if (!text) { if (cb) cb(); return; }
      _speakQueue.push({ text, cb });
      _processQueue();
    },

    /**
     * Hablar inmediatamente, cancelando cualquier cola
     * @param {string} text
     * @param {Function} [cb]
     */
    speakNow(text, cb) {
      _speakQueue = [];
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (typeof ElevenLabs !== 'undefined') ElevenLabs.cancel();
      _processingQueue = false;
      _speaking = false;
      _speakQueue.push({ text, cb });
      _processQueue();
    },

    /** Cancelar toda síntesis y vaciar cola */
    cancel() {
      _speakQueue = [];
      _processingQueue = false;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (typeof ElevenLabs !== 'undefined') ElevenLabs.cancel();
      _speaking = false;
      UI.stopWave();
    },

    /**
     * Iniciar escucha en un modo específico
     * @param {string} mode - 'dest' | 'confirm' | 'free' | 'wake'
     * @param {Function} onResult - callback(text, mode)
     */
    listen(mode, onResult) {
      _onResult = onResult;
      _startMic(mode);
    },

    /** Detener micrófono permanentemente */
    stopListening() {
      _mode = 'off';
      _onResult = null;
      if (_recognition) {
        try { _recognition.stop(); } catch (_) {}
        _recognition = null;
      }
      _micActive = false;
      UI.setMicStatus('', false);
    },

    /** Cambiar modo de escucha sin recrear instancia */
    setMode(mode) {
      _mode = mode;
    },

    get speaking() { return _speaking; },
    get listening() { return _micActive; },
    get mode() { return _mode; },
    isSupportedSynthesis() { return !!window.speechSynthesis; },
    isSupportedRecognition() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },
  };

})();
