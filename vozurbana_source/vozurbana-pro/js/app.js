/**
 * app.js — Controlador principal VozUrbana
 * Orquesta todos los módulos, maneja el flujo conversacional
 */

'use strict';

// ─── Logger global ────────────────────────────
const LOG = {
  info:  (...a) => console.log(`[VozUrbana]`, ...a),
  warn:  (...a) => console.warn(`[VozUrbana]`, ...a),
  debug: (...a) => console.debug(`[VozUrbana]`, ...a),
  error: (...a) => console.error(`[VozUrbana]`, ...a),
};

// ─── Utils globales ───────────────────────────
const Utils = {
  fmtDistSh(m) {
    if (!m && m !== 0) return '--';
    return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm';
  },
  fmtDistSp(m) {
    if (!m) return '';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' kilómetros' : Math.round(m) + ' metros';
  },
  fmtTimeSp(s) {
    if (!s) return '';
    const m = Math.ceil(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)} hora${Math.floor(m / 60) > 1 ? 's' : ''} y ${m % 60} minutos`;
    return m === 1 ? '1 minuto' : `${m} minutos`;
  },
  fmtTimeEta(s) {
    if (!s) return '--';
    const m = Math.ceil(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  },
};

// ─── Estado global ────────────────────────────
const AppState = {
  // GPS
  lat: null, lng: null, gpsOk: false, acc: null,
  // Navegación
  navOn:    false,
  steps:    [],
  stepIdx:  0,
  elapsed:  0,
  totalSec: 0,
  remSec:   0,
  destName: '',
  destLat:  null,
  destLng:  null,
  // Flujo
  confirming: false,
  pending:    null,   // {name, lat, lng}
};

// ─── App principal ────────────────────────────
const App = (() => {

  // ─── Wake word ──────────────────────────────
  const WAKE_WORDS = ['hey asistente', 'oye asistente', 'hey vozurbana',
                      'oye vozurbana', 'hey gemini', 'oye gemini', 'asistente'];
  const STOP_WORDS = ['para', 'stop', 'termina', 'llegué', 'ya llegué',
                      'listo', 'fin', 'terminamos', 'cancelar'];

  let _wakeActive = false;
  let _wakeTmr    = null;
  let _initialized = false;

  // ─── Inicializar app ─────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    LOG.info('VozUrbana iniciando...');

    // Reloj
    UI.updateClock();
    setInterval(UI.updateClock, 30000);

    // Iniciar reactores visuales
    UI.initReactor('rc');
    UI.initReactor('rc2');
    UI.initParticles('bg-c');

    // GPS
    Navigation.startGPS(
      (lat, lng, acc) => {
        AppState.gpsOk = true;
        UI.setIdleSt('Listo — Toca para comenzar');
        UI.setGPS(`GPS ±${acc}m`);
        const d = document.getElementById('dgps');
        const f = document.getElementById('fgps');
        if (d) d.textContent = `±${acc}m`;
        if (f) f.style.width = Math.min(100, Math.max(20, 100 - acc / 3)) + '%';
        const l = document.getElementById('lgps');
        if (l) l.textContent = `GPS ±${acc}m ✓`;
        LOG.info(`GPS listo: ${lat.toFixed(4)}, ${lng.toFixed(4)} ±${acc}m`);
        Voice.speak('Hola. Ya tengo tu ubicación. Toca la pantalla para comenzar.');
      },
      (err) => {
        UI.setIdleSt('Activa el GPS en el navegador');
        Voice.speak('Necesito acceso a tu ubicación GPS. Por favor permite el acceso en el navegador.');
      }
    );

    // Callbacks de navegación
    Navigation.setCallbacks(
      _onNavStep,
      _onNavArrived,
      (lat, lng, acc) => {
        UI.setGPS(`GPS ±${acc}m`);
      }
    );

    // Input de texto
    const inp = document.getElementById('msginp');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _sendTextMessage();
        }
      });
      inp.addEventListener('input', function() {
        this.style.height = '40px';
        this.style.height = Math.min(this.scrollHeight, 80) + 'px';
      });
    }

    document.getElementById('btnsnd')?.addEventListener('click', _sendTextMessage);

    // Teclado global
    document.addEventListener('keydown', (e) => {
      const idle = document.getElementById('s-idle');
      if ((e.key === 'Enter' || e.key === ' ') && !idle?.classList.contains('off')) {
        _onTapIdle({ clientX: innerWidth / 2, clientY: innerHeight / 2 });
      }
    });

    LOG.info('App inicializada');
  }

  // ─── Tap en pantalla idle ─────────────────────
  function _onTapIdle(e) {
    UI.spawnRipple(e.clientX || innerWidth / 2, e.clientY || innerHeight / 2);

    if (!AppState.gpsOk) {
      Voice.speakNow('Todavía estoy buscando tu ubicación. Dame un momento más.');
      return;
    }

    UI.showMain();

    setTimeout(() => {
      const msg = AI.isOnline
        ? 'Hola. Soy VozUrbana, tu asistente de movilidad. ¿A dónde quieres ir hoy?'
        : 'Hola. Estoy en modo sin conexión pero puedo ayudarte. ¿A dónde quieres ir?';
      UI.showAIBubble(msg);
      UI.setMid(AI.isOnline ? 'IA: Gemini ✓' : 'Modo offline');
      Voice.speak(msg, () => Voice.listen('dest', _onVoiceResult));
    }, 400);
  }

  // ─── Manejar resultado de voz ─────────────────
  function _onVoiceResult(text, mode) {
    if (Voice.speaking) return; // anti-bucle

    const t = text.toLowerCase().trim();
    LOG.info(`Voz recibida [${mode}]: "${t}"`);

    // ── Modo confirmación — PRIORIDAD MÁXIMA ──
    // Se activa por estado (AppState.confirming) O por modo 'confirm'
    if (AppState.confirming || mode === 'confirm') {
      const si = ['sí','si','s','yes','claro','correcto','ese','eso','vamos',
                  'adelante','ok','okey','dale','ahí','confirmo','afirmativo',
                  'quiero','llévame','ir','voy'];
      const no = ['no','nope','otro','diferente','equivocado','cambia',
                  'otro lugar','no es','negativo','cancela'];

      LOG.info(`Confirmación: comprobando "${t}"`);

      if (si.some(w => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w))) {
        LOG.info('Confirmación: SÍ detectado');
        _onConfirm(true);
        return;
      }
      if (no.some(w => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w))) {
        LOG.info('Confirmación: NO detectado');
        _onConfirm(false);
        return;
      }

      // No reconoció — pedir de nuevo con ejemplos claros
      LOG.warn(`Confirmación: no reconocida → "${t}"`);
      Voice.speakNow('Di sí para confirmar, o no para buscar otro lugar.');
      setTimeout(() => Voice.listen('confirm', _onVoiceResult), 1400);
      return;
    }

    // ── Wake word durante navegación ──
    if (AppState.navOn && !_wakeActive) {
      if (WAKE_WORDS.some(w => t.includes(w))) {
        _activateWake();
        return;
      }
      // Comandos de parada siempre activos
      if (STOP_WORDS.some(w => t.includes(w))) {
        _stopNav();
        return;
      }
      return; // ignorar el resto durante navegación
    }

    // ── Modo destino ──
    if (mode === 'dest') {
      UI.showUserBubble(text);
      _searchAndNavigate(text);
      return;
    }

    // ── Conversación libre (wake activo o fuera de nav) ──
    UI.showUserBubble(text);
    _handleFreeChat(text);
  }

  // ─── Búsqueda y navegación ────────────────────
  async function _searchAndNavigate(query) {
    UI.showTyping(true);
    UI.setMid('Buscando ' + query + '...');

    const place = await Navigation.searchPlace(query);
    UI.showTyping(false);

    if (!place) {
      const m = `No encontré "${query}". Intenta con el nombre completo, por ejemplo: Mercado Rodríguez La Paz.`;
      UI.showAIBubble(m);
      Voice.speak(m, () => Voice.listen('dest', _onVoiceResult));
      return;
    }

    AppState.pending = place;
    _confirmPlace(place.name);
  }

  function _confirmPlace(name) {
    AppState.confirming = true;
    // Cambiar modo ANTES de hablar para que cualquier reconocimiento
    // que ocurra durante la síntesis ya tenga el modo correcto
    Voice.setMode('confirm');
    const short = name.split(',')[0].trim();
    UI.showConfirm(name);
    const m = `Encontré ${short}. ¿Quieres ir ahí? Di sí o no.`;
    UI.showAIBubble(m);
    // Hablar y luego activar escucha en modo confirm
    Voice.speak(m, () => {
      LOG.info('Activando escucha para confirmación...');
      Voice.listen('confirm', _onVoiceResult);
    });
  }

  function _onConfirm(yes) {
    UI.hideConfirm();
    AppState.confirming = false;

    if (yes) {
      UI.showUserBubble('Sí');
      _checkAndLaunch(AppState.pending);
    } else {
      UI.showUserBubble('No');
      AppState.pending = null;
      const m = '¿A qué otro lugar quieres ir?';
      UI.showAIBubble(m);
      Voice.speak(m, () => Voice.listen('dest', _onVoiceResult));
    }
  }

  async function _checkAndLaunch(place) {
    const checking = 'Revisando el camino, un momento.';
    UI.showAIBubble(checking);
    Voice.speak(checking);
    UI.setMid('Verificando condiciones...');

    const { notes, dist, timeSec } = await Navigation.checkRoadConditions(place);

    let info = '';
    if (dist && timeSec) {
      const distStr = Utils.fmtDistSp(dist);
      const timeStr = Utils.fmtTimeSp(timeSec);
      if (notes.length > 0) {
        info = `Hay ${notes[0]}. La distancia es ${distStr} y tardarás unos ${timeStr} caminando.`;
      } else {
        info = `El camino está despejado. Son ${distStr}, aproximadamente ${timeStr} caminando.`;
      }
      AppState.totalSec = timeSec;
      AppState.remSec   = timeSec;
    } else {
      info = notes.length > 0
        ? 'Hay algunas condiciones en el camino. Te guiaré con cuidado.'
        : 'El camino parece despejado. ¡Vamos!';
    }

    AppState.destName = place.name;
    AppState.destLat  = place.lat;
    AppState.destLng  = place.lng;

    UI.showAIBubble(info);
    Voice.speak(info, () => setTimeout(_launchNav, 400));
  }

  // ─── Lanzar navegación ────────────────────────
  function _launchNav() {
    AppState.navOn = true;
    UI.showNav();
    MapEngine.show();
    MapEngine.init('map', AppState.lat, AppState.lng);
    UI.setMid('→ ' + AppState.destName);

    MapEngine.calcRoute(AppState.destLat, AppState.destLng, {
      onRoute: async (rt, useSec) => {
        const dist = Utils.fmtDistSp(rt.summary.totalDistance);
        const time = Utils.fmtTimeSp(useSec);

        const inst = await AI.generateNavInstruction(
          AppState.steps[0], true, dist, time
        );

        UI.updateNavStep(inst, AppState.steps[0],
          AppState.steps.reduce((s, x) => s + (x.distance || 0), 0));
        UI.showAIBubble(inst);
        Voice.speakNow(inst);

        Navigation.startTimers((elapsed, remSec) => {
          UI.updateHUD(elapsed, remSec);
        });

        Navigation.watchGPS();

        // Durante nav: wake word mode
        Voice.setMode('wake');
        Voice.listen('wake', _onVoiceResult);
        UI.setWakeActive(false);
      },
      onError: () => {
        const m = 'No pude calcular la ruta. ¿Quieres intentar con otro destino?';
        UI.showAIBubble(m);
        Voice.speakNow(m, () => _stopNav());
      }
    });
  }

  // ─── Callbacks de navegación ──────────────────
  async function _onNavStep(inst, step, distRem) {
    LOG.info('Nuevo paso:', inst);
    UI.updateNavStep(inst, step, distRem);
    UI.showAIBubble(inst);
    Voice.speakNow(inst);
    // Tras hablar, volver a wake word mode
    // (speakNow ya llama _resumeMic vía voice.js)
  }

  function _onNavArrived() {
    const m = `¡Llegaste a ${AppState.destName}! Espero haberte acompañado bien. ¡Que tengas un excelente día!`;
    UI.showAIBubble(m);
    Voice.speakNow(m);
    setTimeout(_stopNav, 9000);
  }

  // ─── Detener navegación ───────────────────────
  function _stopNav() {
    if (!AppState.navOn) return;
    AppState.navOn = false;
    Navigation.stopTimers();
    Navigation.stopGPS();
    MapEngine.hide();
    UI.hideNav();
    UI.setMid('Asistente listo');

    // Reiniciar GPS watch para la próxima navegación
    Navigation.watchGPS();

    AppState.steps   = [];
    AppState.stepIdx = 0;
    AppState.elapsed = 0;

    const m = 'Viaje terminado. ¿Quieres ir a otro lugar?';
    UI.showAIBubble(m);
    Voice.speak(m, () => Voice.listen('dest', _onVoiceResult));
  }

  // ─── Wake word ────────────────────────────────
  function _activateWake() {
    _wakeActive = true;
    UI.setWakeActive(true);
    clearTimeout(_wakeTmr);
    Voice.speakNow('Dime.', () => {
      // Escuchar lo que dice el usuario
      Voice.listen('free', (text) => {
        if (!text) return;
        UI.showUserBubble(text);
        _handleFreeChat(text);
        // Auto-desactivar después de responder
        _wakeTmr = setTimeout(_deactivateWake, 8000);
      });
    });
  }

  function _deactivateWake() {
    _wakeActive = false;
    UI.setWakeActive(false);
    if (AppState.navOn) {
      Voice.setMode('wake');
    }
  }

  // ─── Chat libre con Gemini ────────────────────
  async function _handleFreeChat(text) {
    const t = text.toLowerCase();

    // Parar navegación
    if (STOP_WORDS.some(w => t.includes(w)) && AppState.navOn) {
      const m = 'Entendido, paramos.';
      UI.showAIBubble(m);
      Voice.speakNow(m, _stopNav);
      return;
    }

    // Repetir instrucción
    if (t.includes('repite') || t.includes('otra vez') || t.includes('qué debo')) {
      const inst = document.getElementById('nvmain')?.textContent;
      if (inst) { Voice.speakNow(inst); UI.showAIBubble(inst); }
      return;
    }

    // Gemini
    UI.showTyping(true);
    const { text: aiText, commands } = await AI.ask(text);
    UI.showTyping(false);

    if (aiText) { UI.showAIBubble(aiText); Voice.speakNow(aiText); }
    if (commands.stop && AppState.navOn)  setTimeout(_stopNav, 1800);
    if (commands.repeat && AppState.navOn) {
      const inst = document.getElementById('nvmain')?.textContent;
      if (inst) setTimeout(() => { Voice.speakNow(inst); UI.showAIBubble(inst); }, 900);
    }
    if (commands.nav) setTimeout(() => _searchAndNavigate(commands.nav), 1500);

    // Volver a escuchar
    setTimeout(() => {
      if (AppState.navOn) {
        Voice.setMode('wake');
        _deactivateWake();
      } else {
        Voice.listen('dest', _onVoiceResult);
      }
    }, 500);
  }

  // ─── Enviar mensaje de texto ──────────────────
  async function _sendTextMessage() {
    const inp = document.getElementById('msginp');
    if (!inp) return;
    const txt = inp.value.trim();
    if (!txt) return;
    inp.value = ''; inp.style.height = '40px';

    UI.showUserBubble(txt);
    UI.showTyping(true);
    const { text: aiText, commands } = await AI.ask(txt);
    UI.showTyping(false);

    if (aiText) { UI.showAIBubble(aiText); Voice.speak(aiText); }
    if (commands.stop && AppState.navOn)  setTimeout(_stopNav, 1800);
    if (commands.nav) setTimeout(() => _searchAndNavigate(commands.nav), 1500);
  }

  // ─── API pública ──────────────────────────────
  return {
    init,
    onTapIdle: _onTapIdle,
  };

})();

// ─── Arranque ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
