/**
 * ai.js — Módulo de Inteligencia Artificial VozUrbana
 * Gemini 2.0 Flash + fallback offline completo
 * Debounce, timeout, reintentos, modo sin conexión
 */

'use strict';

const AI = (() => {

  // ─── Configuración ────────────────────────────
  const GEMINI_KEY = () => localStorage.getItem('urban') || '';
  const GEMINI_URL = () => {
    const k = GEMINI_KEY();
    if (k.startsWith('AQ.')) {
      return 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    }
    return `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${k}`;
  };
  const GEMINI_HEADERS = () => {
    const k = GEMINI_KEY();
    const h = { 'Content-Type': 'application/json' };
    if (k.startsWith('AQ.')) h['x-goog-api-key'] = k;
    return h;
  };
  const TIMEOUT_MS = 8000;   // 8s timeout por request
  const MAX_HISTORY = 20;    // máximo de mensajes en historial

  // ─── Estado ───────────────────────────────────
  let _history      = [];
  let _pendingFetch = null;  // AbortController activo
  let _online       = navigator.onLine;
  let _quotaExhausted = false; // true si Gemini devolvió 429

  // Detectar cambios de conexión
  window.addEventListener('online',  () => { _online = true;  LOG.info('🌐 Conexión restaurada'); });
  window.addEventListener('offline', () => { _online = false; LOG.warn('📵 Sin conexión'); });

  // ─── System Prompt dinámico ───────────────────
  function _buildPrompt() {
    const hora = new Date().toLocaleTimeString('es-BO', { hour:'2-digit', minute:'2-digit' });
    const nav  = AppState.navOn
      ? `NAVEGANDO a "${AppState.destName}". Tiempo restante: ${Utils.fmtTimeSp(AppState.remSec)}.`
      : 'Sin ruta activa.';
    const gps = AppState.lat
      ? `${AppState.lat.toFixed(4)}, ${AppState.lng.toFixed(4)}`
      : 'desconocida';

    return `Eres VozUrbana, asistente de movilidad urbana del Instituto Boliviano de la Ceguera (IBC Bolivia).
Ayudas a personas con discapacidad visual a moverse por la ciudad.

PERSONALIDAD:
- Hablas como un amigo cálido y cercano, no como un robot
- Usas lenguaje boliviano natural y coloquial
- Eres breve: máximo 2 oraciones por respuesta
- Eres paciente y empático
- Recuerdas el contexto de toda la conversación

CONTEXTO ACTUAL:
- Hora: ${hora}
- Ubicación GPS: ${gps} (Bolivia)
- Estado: ${nav}

COMANDOS ESPECIALES (agrega al final cuando aplique):
[NAV:nombre_lugar] — cuando el usuario quiera navegar a algún lugar
[STOP] — cuando quiera terminar la ruta actual
[REPEAT] — cuando quiera repetir la instrucción actual

REGLAS:
- Responde en oraciones naturales, NUNCA en listas con guiones
- Si el usuario menciona un destino, siempre confirma con [NAV:]
- Emergencias: responde primero con calma, luego con [STOP] si navega
- Para conversación libre (clima, preguntas, apoyo): responde sin comandos`;
  }

  // ─── Llamada a Gemini con timeout ────────────
  async function _callGemini(userMsg) {
    // Si hay cuota excedida reciente, usar offline directamente
    if (_quotaExhausted) {
      LOG.debug('Gemini: cuota excedida, usando offline');
      return null;
    }
    // Cancelar petición anterior si existe
    if (_pendingFetch) {
      _pendingFetch.abort();
      _pendingFetch = null;
    }

    const controller = new AbortController();
    _pendingFetch = controller;

    const timeout = setTimeout(() => {
      controller.abort();
      LOG.warn('Gemini: timeout');
    }, TIMEOUT_MS);

    const contents = [
      { role: 'user',  parts: [{ text: _buildPrompt() }] },
      { role: 'model', parts: [{ text: 'Entendido, listo para ayudar.' }] },
      ..._history.map(h => ({ role: h.r, parts: [{ text: h.t }] })),
      { role: 'user',  parts: [{ text: userMsg }] },
    ];

    try {
      const res = await fetch(GEMINI_URL(), {
        method: 'POST',
        headers: GEMINI_HEADERS(),
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature:    0.78,
            maxOutputTokens: 200,
            topP:           0.92,
          }
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      _pendingFetch = null;

      if (!res.ok) {
        const err = await res.text();
        LOG.warn(`Gemini HTTP ${res.status}:`, err.slice(0, 150));
        if (res.status === 429) {
          // Cuota excedida — pausar Gemini por 60s
          _quotaExhausted = true;
          LOG.warn('Gemini: cuota excedida. Modo offline por 60 segundos.');
          setTimeout(() => {
            _quotaExhausted = false;
            LOG.info('Gemini: reactivado después de pausa por cuota');
          }, 60000);
        }
        return null;
      }

      const data = await res.json();

      if (data.error) {
        LOG.warn('Gemini API error:', data.error.message);
        return null;
      }

      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

    } catch (e) {
      clearTimeout(timeout);
      _pendingFetch = null;
      if (e.name === 'AbortError') {
        LOG.warn('Gemini: petición cancelada');
      } else {
        LOG.warn('Gemini fetch error:', e.message);
      }
      return null;
    }
  }

  // ─── Respuestas offline inteligentes ─────────
  function _offlineFallback(msg) {
    const m = msg.toLowerCase().trim();

    // Saludos
    if (/^(hola|buenos días|buenas tardes|buenas noches|hey|oye)/.test(m))
      return '¡Hola! Estoy en modo sin conexión, pero puedo ayudarte. ¿A dónde quieres ir?';

    // Gratitud
    if (m.includes('gracias') || m.includes('muy amable'))
      return '¡Con mucho gusto! Siempre aquí para ti.';

    // Cómo estás
    if (m.includes('cómo estás') || m.includes('cómo te va') || m.includes('qué tal'))
      return '¡Muy bien! Listo para acompañarte. ¿A dónde vamos?';

    // Parar navegación
    if (/\b(para|stop|termina|llegué|ya llegué|listo|fin|terminamos|cancelar)\b/.test(m))
      return 'Entendido, paramos aquí. [STOP]';

    // Repetir instrucción
    if (m.includes('repite') || m.includes('otra vez') || m.includes('no escuché') || m.includes('qué debo'))
      return 'Claro, te repito. [REPEAT]';

    // Cuánto falta
    if (m.includes('falta') || m.includes('cuánto') || m.includes('tiempo')) {
      if (AppState.navOn)
        return `Te faltan aproximadamente ${Utils.fmtTimeSp(AppState.remSec)} para llegar a ${AppState.destName}.`;
      return '¿A dónde quieres ir? Dime el nombre del lugar.';
    }

    // Emergencia
    if (m.includes('auxilio') || m.includes('emergencia') || m.includes('socorro') || m.includes('peligro'))
      return 'Estoy contigo. Quédate tranquilo. Di "para" si necesitas detener la ruta.';

    // Destino explícito
    const navPatterns = [
      /(?:quiero ir|ir|llevar|llévame|vamos|navega|cómo llego)\s+(?:a|al|hacia)?\s+(.+)/i,
      /(?:llevarme|navegar|ir)\s+(?:a|al)?\s+(.+)/i,
    ];
    for (const pat of navPatterns) {
      const match = msg.match(pat);
      if (match && match[1]?.trim()) {
        const dest = match[1].trim();
        return `¡Vamos! Te llevo a ${dest}. [NAV:${dest}]`;
      }
    }

    // Respuesta genérica
    return 'Estoy en modo sin conexión. Puedo llevarte a lugares o darte información básica. ¿A dónde quieres ir?';
  }

  // ─── API pública ──────────────────────────────
  return {

    /**
     * Enviar mensaje al asistente
     * @param {string} userMsg
     * @returns {Promise<{text: string, commands: Object}>}
     */
    async ask(userMsg) {
      LOG.info(`🧠 Pregunta a IA: "${userMsg.slice(0, 60)}"`);

      let rawText = null;

      if (_online) {
        rawText = await _callGemini(userMsg);
      }

      if (!rawText) {
        LOG.info('IA: usando respuesta offline');
        rawText = _offlineFallback(userMsg);
      }

      // Guardar en historial
      _history.push({ r: 'user',  t: userMsg });
      _history.push({ r: 'model', t: rawText });
      if (_history.length > MAX_HISTORY) _history.splice(0, 2);

      // Parsear comandos
      const navMatch = rawText.match(/\[NAV:([^\]]+)\]/);
      const commands = {
        nav:    navMatch ? navMatch[1].trim() : null,
        stop:   rawText.includes('[STOP]'),
        repeat: rawText.includes('[REPEAT]'),
      };

      // Texto limpio sin comandos
      const clean = rawText
        .replace(/\[NAV:[^\]]+\]/g, '')
        .replace(/\[STOP\]/g, '')
        .replace(/\[REPEAT\]/g, '')
        .trim();

      return { text: clean, commands };
    },

    /**
     * Normalizar nombre de lugar con Gemini
     * @param {string} query
     * @returns {Promise<string>}
     */
    async normalizePlaceName(query) {
      // ── Diccionario local boliviano ──
      // Evita gastar tokens de Gemini en lugares muy comunes
      const PLACES_BO = {
        // La Paz
        'plaza murillo':        'Plaza Murillo La Paz Bolivia',
        'mercado rodríguez':    'Mercado Rodríguez La Paz Bolivia',
        'mercado rodriguez':    'Mercado Rodríguez La Paz Bolivia',
        'sopocachi':            'Sopocachi La Paz Bolivia',
        'miraflores':           'Miraflores La Paz Bolivia',
        'san francisco':        'Iglesia San Francisco La Paz Bolivia',
        'el prado':             'El Prado La Paz Bolivia',
        'camacho':              'Avenida Camacho La Paz Bolivia',
        'villa fátima':         'Villa Fátima La Paz Bolivia',
        'villa fatima':         'Villa Fátima La Paz Bolivia',
        'max paredes':          'Max Paredes La Paz Bolivia',
        'cementerio':           'Cementerio General La Paz Bolivia',
        'terminal':             'Terminal de Buses La Paz Bolivia',
        'aeropuerto':           'Aeropuerto El Alto Bolivia',
        'el alto':              'El Alto Bolivia',
        'ibc':                  'Instituto Boliviano de la Ceguera La Paz Bolivia',
        // Cochabamba
        'plaza 14 de septiembre': 'Plaza 14 de Septiembre Cochabamba Bolivia',
        'cancha':               'La Cancha Cochabamba Bolivia',
        'quillacollo':          'Quillacollo Cochabamba Bolivia',
        // Santa Cruz
        'plaza 24 de septiembre': 'Plaza 24 de Septiembre Santa Cruz Bolivia',
        'equipetrol':           'Equipetrol Santa Cruz Bolivia',
        'montero':              'Montero Santa Cruz Bolivia',
        // General
        'hospital':             'Hospital Bolivia',
        'universidad':          'Universidad Bolivia',
        'banco union':          'Banco Unión Bolivia',
        'banco bnb':            'Banco BNB Bolivia',
      };

      const q = query.toLowerCase().trim();
      for (const [key, val] of Object.entries(PLACES_BO)) {
        if (q.includes(key)) {
          LOG.info(`Lugar en diccionario local: "${query}" → "${val}"`);
          return val;
        }
      }

      // Si no está en el diccionario, usar Gemini
      if (!_online) return query;

      const prompt =
        `El usuario en Bolivia quiere ir a: "${query}".\n` +
        `Dame el nombre oficial completo de ese lugar en Bolivia para buscar en un mapa.\n` +
        `Si es un lugar conocido de Bolivia (mercado, plaza, hospital, barrio), pon el nombre de la ciudad también.\n` +
        `Responde SOLO con el nombre. Máximo 8 palabras. Sin explicaciones.`;
      try {
        const res = await fetch(GEMINI_URL(), {
          method: 'POST',
          headers: GEMINI_HEADERS(),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 30, temperature: 0.2 }
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return query;
        const d = await res.json();
        const t = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return (t && t.length > 2 && t.length < 80) ? t : query;
      } catch (_) {
        return query;
      }
    },

    /**
     * Generar instrucción de navegación con Gemini
     * @param {Object} step - paso de OSRM
     * @param {boolean} isFirst
     * @param {string} totalDist
     * @param {string} totalTime
     * @returns {Promise<string>}
     */
    async generateNavInstruction(step, isFirst, totalDist, totalTime) {
      const mod = (step.modifier || 'recto').toLowerCase();
      const road = step.road || 'la calle';
      const dist = Math.round(step.distance || 0);
      const isLast = step.type === 'DestinationReached';

      const prompt =
        `Instrucción de navegación para persona con discapacidad visual en Bolivia.\n` +
        `Maniobra: ${step.type}, dirección: ${mod}, calle: ${road}, distancia: ${dist}m.\n` +
        (isFirst ? `Es el primer paso. Destino: ${AppState.destName}. Total: ${totalDist}, tiempo: ${totalTime}.\n` : '') +
        (isLast  ? `Es la llegada al destino. Celebra con calidez y emoción.\n` : '') +
        `Escribe UNA instrucción natural, cálida, máximo 12 palabras. Solo la instrucción, sin comillas.`;

      if (!_online) return _fallbackStep(step, isFirst, totalDist, totalTime);

      try {
        const res = await fetch(GEMINI_URL(), {
          method: 'POST',
          headers: GEMINI_HEADERS(),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 55, temperature: 0.65 }
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return _fallbackStep(step, isFirst, totalDist, totalTime);
        const d = await res.json();
        return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
          || _fallbackStep(step, isFirst, totalDist, totalTime);
      } catch (_) {
        return _fallbackStep(step, isFirst, totalDist, totalTime);
      }
    },

    /** Limpiar historial de conversación */
    clearHistory() {
      _history = [];
      LOG.info('Historial de IA limpiado');
    },

    get isOnline() { return _online; },
  };

  // ─── Fallback de instrucción de paso ──────────
  function _fallbackStep(st, isFirst, td, tt) {
    if (st.type === 'DestinationReached') return `¡Llegaste a ${AppState.destName}!`;
    const m = (st.modifier || '').toLowerCase();
    const c = st.road ? ` por ${st.road}` : '';
    const d = st.distance ? ` en ${Math.round(st.distance)} metros` : '';
    if (isFirst) return `Vamos a ${AppState.destName}, ${td}, ${tt}. Empieza a caminar${c}.`;
    if (m.includes('left'))  return `Gira a la izquierda${c}${d}.`;
    if (m.includes('right')) return `Gira a la derecha${c}${d}.`;
    if (m.includes('uturn')) return `Da la vuelta${c}${d}.`;
    return `Continúa recto${c}${d}.`;
  }

})();
