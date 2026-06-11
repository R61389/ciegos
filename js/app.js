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
  confirming:   false,
  pending:      null,    // {name, lat, lng}
  // Guardar ruta
  savingRoute:  false,   // true cuando se pregunta si guardar
  lastRouteDist: null,   // metros de la última ruta completada
  lastRouteSec:  null,   // segundos de la última ruta completada
};

// ─── App principal ────────────────────────────
const App = (() => {

  // ─── Comandos de control ────────────────────
  // Nota: el filtro "vozurbana" se aplica en voice.js antes de llegar aquí.
  // Estos arrays solo detectan lo que viene DESPUÉS del prefijo.

  const STOP_WORDS  = ['para', 'stop', 'termina', 'llegué', 'ya llegué',
                       'listo', 'fin', 'terminamos', 'cancelar', 'detente'];
  const ALTO_WORDS  = ['alto', 'silencio', 'cállate', 'desactívate', 'apágate'];
  const SAVE_WORDS  = [
    'guarda esta ubicación', 'guarda la ruta',   'guardar ubicación',
    'guarda este lugar',     'memoriza',          'guarda la dirección',
    'guardar ruta',          'guardar lugar',     'guarda esta dirección',
    'guarda esta ruta',      'guardar esta ruta', 'guardar aquí',
  ];
  const ROUTES_WORDS = ['mis rutas', 'rutas guardadas', 'lugares guardados',
                        'ver rutas', 'mostrar rutas'];

  let _initialized = false;

  // ─── Inicializar app ─────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    LOG.info('VozUrbana iniciando...');

    // ── Módulo ESP32 ──
    SensorPanel.init();

    // ── Módulo Rutas Guardadas ──
    RoutesPanel.init();

    // ── Modal ElevenLabs ──
    _initELSettings();

    // Botón limpiar registro ESP32
    document.getElementById('esp-log-clear')?.addEventListener('click', () => {
      EventLog.clear();
      const list = document.getElementById('esp-log-list');
      if (list) {
        list.innerHTML = '<div class="esp-log-empty">Sin registros aún.<br>Conecta el ESP32 para comenzar.</div>';
      }
    });

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
        Voice.speak('Hola. Ya tengo tu ubicación. Toca la pantalla para comenzar. Recuerda siempre decir vozurbana antes de cada instrucción.');
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
        ? 'Hola. Soy VozUrbana. Di vozurbana seguido de tu instrucción. Por ejemplo: vozurbana llévame al mercado.'
        : 'Hola. Estoy en modo sin conexión. Di vozurbana seguido de a dónde quieres ir.';
      UI.showAIBubble(msg);
      UI.setMid(AI.isOnline ? 'IA: Gemini ✓' : 'Modo offline');
      UI.setWakeActive(false);
      Voice.speak(msg, () => Voice.listen('dest', _onVoiceResult));
    }, 400);
  }

  // ─── Manejar resultado de voz ─────────────────
  // Nota: "text" ya llega SIN el prefijo "vozurbana" (filtrado en voice.js).
  // Un text vacío significa que el usuario solo dijo "vozurbana" sin comando.
  function _onVoiceResult(text, mode) {
    if (Voice.speaking) return; // anti-bucle

    const t = text.toLowerCase().trim();
    LOG.info(`Vozurbana [${mode}]: "${t || '(vacío)'}"`);

    // ── ALTO — desactivar asistente completamente ──
    if (ALTO_WORDS.some(w => t === w || t.startsWith(w))) {
      _onAlto();
      return;
    }

    // ── COMANDO VACÍO — solo dijeron "vozurbana" ──
    if (!t) {
      _onOnlyWakeWord(mode);
      return;
    }

    // ── Confirmación guardar ruta — PRIORIDAD MÁXIMA ──
    if (AppState.savingRoute) {
      const si = ['sí','si','yes','claro','dale','quiero','guardar','bueno','afirmativo','correcto'];
      const no = ['no','nope','negativo','omitir','saltar','cancela'];

      if (si.some(w => t === w || t.startsWith(w))) {
        LOG.info('Guardar ruta: SÍ');
        AppState.savingRoute = false;
        _doSaveCurrentRoute();
        return;
      }
      if (no.some(w => t === w || t.startsWith(w))) {
        LOG.info('Guardar ruta: NO');
        AppState.savingRoute = false;
        _stopNav();
        return;
      }
      Voice.speakNow('Di vozurbana sí para guardar, o vozurbana no para omitir.');
      setTimeout(() => Voice.listen('confirm', _onVoiceResult), 1300);
      return;
    }

    // ── Confirmación de destino ──
    if (AppState.confirming || mode === 'confirm') {
      const si = ['sí','si','yes','claro','correcto','ese','eso','vamos',
                  'adelante','ok','okey','dale','confirmo','afirmativo',
                  'quiero','llévame','voy'];
      const no = ['no','nope','otro','diferente','equivocado','cambia',
                  'otro lugar','negativo','cancela'];

      LOG.info(`Confirmación vozurbana: "${t}"`);

      if (si.some(w => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w))) {
        _onConfirm(true); return;
      }
      if (no.some(w => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w))) {
        _onConfirm(false); return;
      }

      Voice.speakNow('Di vozurbana sí para confirmar, o vozurbana no para buscar otro lugar.');
      setTimeout(() => Voice.listen('confirm', _onVoiceResult), 1400);
      return;
    }

    // ── Durante navegación: cualquier comando vehiculado por vozurbana ──
    if (AppState.navOn) {
      if (STOP_WORDS.some(w => t.includes(w))) {
        const m = 'Entendido, paramos.';
        UI.showAIBubble(m);
        Voice.speakNow(m, _stopNav);
        return;
      }
      // Repetir instrucción
      if (t.includes('repite') || t.includes('otra vez') || t.includes('qué debo') || t.includes('dónde')) {
        const inst = document.getElementById('nvmain')?.textContent;
        if (inst) { Voice.speakNow(inst); UI.showAIBubble(inst); }
        return;
      }
      // Cualquier otro comando pasa al chat libre
      UI.showUserBubble(`vozurbana ${t}`);
      _handleFreeChat(t);
      return;
    }

    // ── Modo destino (fuera de navegación) ──
    if (mode === 'dest' || mode === 'free') {
      UI.showUserBubble(`vozurbana ${t}`);
      _searchAndNavigate(t);
      return;
    }

    // ── Conversación libre ──
    UI.showUserBubble(`vozurbana ${t}`);
    _handleFreeChat(t);
  }

  // ── Solo dijeron "vozurbana" — responder y esperar ──
  function _onOnlyWakeWord(mode) {
    let m;
    if (AppState.savingRoute)    m = 'Di vozurbana sí para guardar, o vozurbana no para omitir.';
    else if (AppState.confirming) m = 'Di vozurbana sí para confirmar, o vozurbana no para otro lugar.';
    else if (AppState.navOn)      m = 'Dime, ¿en qué te ayudo?';
    else                          m = 'Dime, ¿a dónde quieres ir?';

    UI.showAIBubble(m);
    Voice.speakNow(m, () => Voice.listen(mode || Voice.mode, _onVoiceResult));
  }

  // ── "vozurbana alto" — apagar asistente ──
  function _onAlto() {
    LOG.info('Vozurbana ALTO — asistente en espera');
    Voice.cancel();
    if (AppState.navOn) {
      Navigation.stopTimers();
      MapEngine.hide();
      UI.hideNav();
    }
    AppState.navOn       = false;
    AppState.confirming  = false;
    AppState.savingRoute = false;

    const m = 'De acuerdo, me quedo en silencio. Di vozurbana cuando me necesites.';
    UI.showAIBubble(m);
    UI.setMid('En espera — di «vozurbana»');
    UI.setWakeActive(false);

    // Hablar con síntesis pero NO reactivar el mic en callback
    // El mic sigue activo solo para detectar el próximo "vozurbana"
    Voice.speak(m);
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
    // Guardar datos de ruta para el save posterior
    AppState.lastRouteDist = dist   || null;
    AppState.lastRouteSec  = timeSec || null;

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

        // Durante nav: escuchar en modo libre — vozurbana requerido en voice.js
        Voice.setMode('free');
        Voice.listen('free', _onVoiceResult);
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
    const m = `¡Llegaste a ${AppState.destName}! Espero haberte acompañado bien.`;
    UI.showAIBubble(m);
    // Tras celebrar, preguntar si desea guardar la ruta
    Voice.speakNow(m, () => setTimeout(_askSaveRoute, 1200));
  }

  // ─── Preguntar si guardar ruta ────────────────
  function _askSaveRoute() {
    const short = AppState.destName.split(',')[0].trim();
    const m = `¿Quieres guardar "${short}" en tus rutas favoritas? Di sí o no.`;
    AppState.savingRoute = true;
    Voice.setMode('confirm');
    UI.showAIBubble(m);
    Voice.speak(m, () => Voice.listen('confirm', _onVoiceResult));
  }

  function _doSaveCurrentRoute() {
    const short = AppState.destName.split(',')[0].trim();
    RoutesPanel.addRoute(
      AppState.destName,
      AppState.destLat,
      AppState.destLng,
      AppState.lastRouteDist,
      AppState.lastRouteSec
    );
    const m = `¡Listo! Guardé "${short}" en tus rutas. Puedes volver aquí cuando quieras.`;
    UI.showAIBubble(m);
    Voice.speak(m, _stopNav);
    LOG.info(`[App] Ruta guardada: ${AppState.destName}`);
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

  // ─── Chat libre con Gemini ────────────────────
  async function _handleFreeChat(text) {
    const t = text.toLowerCase();

    // Guardar ubicación / ruta actual
    if (SAVE_WORDS.some(w => t.includes(w))) {
      if (AppState.destName) {
        _doSaveCurrentRoute();
      } else {
        // Guardar posición GPS actual sin destino específico
        if (AppState.lat && AppState.lng) {
          RoutesPanel.addRoute(
            `Mi ubicación ${new Date().toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit' })}`,
            AppState.lat, AppState.lng, null, null
          );
          const m = 'Listo, guardé tu ubicación actual en tus rutas.';
          UI.showAIBubble(m);
          Voice.speakNow(m);
        } else {
          const m = 'Todavía no tengo tu ubicación GPS. Espera un momento.';
          UI.showAIBubble(m);
          Voice.speakNow(m);
        }
      }
      setTimeout(() => {
        if (!AppState.navOn) Voice.listen('dest', _onVoiceResult);
      }, 500);
      return;
    }

    // Ver rutas guardadas
    if (ROUTES_WORDS.some(w => t.includes(w))) {
      RoutesPanel.open();
      const n   = SavedRoutes.count();
      const m   = n > 0
        ? `Tienes ${n} ruta${n > 1 ? 's' : ''} guardada${n > 1 ? 's' : ''}. Te las muestro en pantalla.`
        : 'Aún no tienes rutas guardadas. Cuando llegues a un lugar puedes guardarla.';
      UI.showAIBubble(m);
      Voice.speakNow(m);
      setTimeout(() => {
        if (!AppState.navOn) Voice.listen('dest', _onVoiceResult);
      }, 500);
      return;
    }

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

    // Volver a escuchar — siempre en modo 'dest' (filtro vozurbana activo en voice.js)
    setTimeout(() => {
      Voice.listen(AppState.navOn ? 'free' : 'dest', _onVoiceResult);
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

  // ─── ElevenLabs Settings Modal ───────────────
  function _initELSettings() {
    const btn     = document.getElementById('el-settings-btn');
    const modal   = document.getElementById('el-modal');
    const close   = document.getElementById('el-modal-close');
    const keyInp  = document.getElementById('el-api-key');
    const voiceSel= document.getElementById('el-voice-select');
    const testBtn = document.getElementById('el-test-btn');
    const saveBtn = document.getElementById('el-save-btn');
    const fetchBtn= document.getElementById('el-fetch-voices');

    if (!btn || !modal) return;

    // Pre-rellenar si ya hay config
    if (keyInp)   keyInp.value = ElevenLabs.apiKey;
    if (voiceSel) _populateVoiceSelect(voiceSel, ElevenLabs.voiceId, ElevenLabs.presetVoices);

    // Toggle mostrar/ocultar clave
    document.getElementById('el-toggle-key')?.addEventListener('click', () => {
      if (!keyInp) return;
      keyInp.type = keyInp.type === 'password' ? 'text' : 'password';
    });

    // Actualizar badge si ya está configurado
    const badge = document.getElementById('el-active-badge');
    if (badge) badge.style.display = ElevenLabs.isConfigured() ? 'flex' : 'none';

    btn.addEventListener('click', () => {
      modal.classList.add('open');
      if (typeof Motion !== 'undefined') {
        Motion.animate(modal.querySelector('.el-modal-box'),
          { opacity: [0, 1], scale: [0.93, 1] },
          { duration: 0.3, easing: [0.34, 1.56, 0.64, 1] });
      }
    });

    const _closeModal = () => {
      if (typeof Motion !== 'undefined') {
        Motion.animate(modal.querySelector('.el-modal-box'),
          { opacity: [1, 0], scale: [1, 0.93] },
          { duration: 0.22 }).then(() => modal.classList.remove('open'));
      } else { modal.classList.remove('open'); }
    };

    close?.addEventListener('click', _closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) _closeModal(); });

    testBtn?.addEventListener('click', async () => {
      const key = keyInp?.value.trim();
      if (!key) { _elStatus('Ingresa tu API Key primero', 'warn'); return; }
      ElevenLabs.configure({ apiKey: key, voiceId: voiceSel?.value });
      testBtn.disabled = true;
      testBtn.textContent = 'Probando…';
      _elStatus('Generando audio…', 'info');
      const ok = await ElevenLabs.testVoice();
      testBtn.disabled = false;
      testBtn.textContent = 'Probar';
      _elStatus(ok ? '✓ Voz funcionando correctamente' : '✗ Error — verifica tu API Key', ok ? 'ok' : 'err');
    });

    fetchBtn?.addEventListener('click', async () => {
      const key = keyInp?.value.trim();
      if (!key) { _elStatus('Ingresa tu API Key primero', 'warn'); return; }
      ElevenLabs.configure({ apiKey: key });
      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Cargando…';
      const voices = await ElevenLabs.fetchUserVoices();
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Cargar mis voces';
      if (voices.length > 0) {
        _populateVoiceSelect(voiceSel, ElevenLabs.voiceId, voices);
        _elStatus(`✓ ${voices.length} voces encontradas`, 'ok');
      } else {
        _elStatus('No se pudieron cargar voces', 'err');
      }
    });

    saveBtn?.addEventListener('click', () => {
      const key     = keyInp?.value.trim();
      const voiceId = voiceSel?.value;
      if (!key) { _elStatus('Ingresa tu API Key', 'warn'); return; }
      ElevenLabs.configure({ apiKey: key, voiceId });
      _elStatus('✓ Configuración guardada', 'ok');
      setTimeout(_closeModal, 1200);
      // Actualizar badge en header
      const badge = document.getElementById('el-active-badge');
      if (badge) badge.style.display = ElevenLabs.isConfigured() ? 'flex' : 'none';
    });
  }

  function _populateVoiceSelect(select, currentId, voices) {
    if (!select) return;
    select.innerHTML = voices.map(v =>
      `<option value="${v.id}" ${v.id === currentId ? 'selected' : ''}>${v.name}</option>`
    ).join('');
  }

  function _elStatus(msg, type) {
    const el = document.getElementById('el-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className   = `el-status ${type || ''}`;
  }

  // ─── API pública ──────────────────────────────
  return {
    init,
    onTapIdle: _onTapIdle,
    // Navegar a ruta guardada (llamado desde RoutesPanel)
    navigateTo(route) {
      if (!AppState.gpsOk) {
        Voice.speakNow('Necesito tu ubicación GPS para navegar.');
        return;
      }
      AppState.pending = { name: route.name, lat: route.lat, lng: route.lng };
      AppState.lastRouteDist = route.distMeters;
      AppState.lastRouteSec  = route.timeSec;
      const short = route.name.split(',')[0].trim();
      const m = `¡Vamos a ${short}! Calculando la ruta.`;
      UI.showAIBubble(m);
      Voice.speakNow(m, () => _checkAndLaunch(AppState.pending));
    },
  };

})();

// ─── Arranque ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
