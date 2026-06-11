/**
 * elevenlabs.js — Servicio ElevenLabs TTS para VozUrbana
 * Texto a voz de alta calidad con fallback a Web Speech API
 * Configuración persistida en localStorage
 */

'use strict';

const ElevenLabs = (() => {
  const API_BASE     = 'https://api.elevenlabs.io/v1';
  const MODEL_ID     = 'eleven_multilingual_v2';
  const TIMEOUT_MS   = 20000;

  // Voces preseleccionadas multilingüe (buenas en español)
  const PRESET_VOICES = [
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam — Hombre, cálido'       },
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel — Mujer, suave'        },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella — Mujer, expresiva'     },
    { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold — Hombre, fuerte'      },
    { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh — Hombre, joven'         },
    { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi — Mujer, confiada'       },
    { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli — Mujer, suave'          },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel — Hombre, profundo'    },
    { id: 'CwhRBWXHgrhCdvNEgX6U', name: 'Roger — Hombre, expresivo'    },
    { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria — Mujer, conversacional' },
  ];

  // ─── Estado ───────────────────────────────────
  let _apiKey      = localStorage.getItem('el_api_key')   || '';
  let _voiceId     = localStorage.getItem('el_voice_id')  || PRESET_VOICES[0].id;
  let _stability   = parseFloat(localStorage.getItem('el_stability')   || '0.45');
  let _similarity  = parseFloat(localStorage.getItem('el_similarity')  || '0.75');
  let _style       = parseFloat(localStorage.getItem('el_style')       || '0.3');

  let _currentAudio  = null;
  let _currentObjUrl = null;
  let _onEnd         = null;
  let _isSpeaking    = false;

  // ─── ¿Está configurado? ───────────────────────
  function isConfigured() {
    return _apiKey.length > 10;
  }

  // ─── Hablar ───────────────────────────────────
  async function speak(text, onStart, onEnd) {
    if (!isConfigured() || !text) return false;

    _onEnd = onEnd;
    _isSpeaking = true;

    try {
      const res = await fetch(`${API_BASE}/text-to-speech/${_voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key':   _apiKey,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: {
            stability:       _stability,
            similarity_boost: _similarity,
            style:           _style,
            use_speaker_boost: true,
          },
          language_code: 'es',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        LOG.warn(`[ElevenLabs] HTTP ${res.status}:`, err.slice(0, 100));
        _isSpeaking = false;
        return false;
      }

      const blob     = await res.blob();
      const objUrl   = URL.createObjectURL(blob);

      // Limpiar audio anterior
      _freeCurrentAudio();
      _currentObjUrl = objUrl;

      const audio = new Audio(objUrl);
      _currentAudio = audio;

      audio.oncanplay = () => {
        if (onStart) onStart();
      };

      audio.onended = () => {
        _isSpeaking = false;
        _freeCurrentAudio();
        if (_onEnd) { _onEnd(); _onEnd = null; }
      };

      audio.onerror = (e) => {
        LOG.warn('[ElevenLabs] Audio error:', e);
        _isSpeaking = false;
        _freeCurrentAudio();
        if (_onEnd) { _onEnd(); _onEnd = null; }
      };

      await audio.play();
      LOG.info(`[ElevenLabs] Reproduciendo: "${text.slice(0, 40)}…"`);
      return true;

    } catch (e) {
      _isSpeaking = false;
      if (e.name === 'AbortError') {
        LOG.warn('[ElevenLabs] Timeout de síntesis');
      } else {
        LOG.warn('[ElevenLabs] Error:', e.message);
      }
      return false;
    }
  }

  // ─── Cancelar audio en curso ──────────────────
  function cancel() {
    _isSpeaking = false;
    if (_currentAudio) {
      _currentAudio.pause();
    }
    _freeCurrentAudio();
    _onEnd = null;
  }

  function _freeCurrentAudio() {
    if (_currentAudio) {
      _currentAudio.onended = null;
      _currentAudio.onerror = null;
      _currentAudio.oncanplay = null;
      _currentAudio.pause();
      _currentAudio = null;
    }
    if (_currentObjUrl) {
      URL.revokeObjectURL(_currentObjUrl);
      _currentObjUrl = null;
    }
  }

  // ─── Configurar y persistir ───────────────────
  function configure({ apiKey, voiceId, stability, similarity, style } = {}) {
    if (apiKey   !== undefined) { _apiKey    = apiKey;      localStorage.setItem('el_api_key',    apiKey); }
    if (voiceId  !== undefined) { _voiceId   = voiceId;     localStorage.setItem('el_voice_id',   voiceId); }
    if (stability  !== undefined) { _stability  = stability;  localStorage.setItem('el_stability',  stability); }
    if (similarity !== undefined) { _similarity = similarity; localStorage.setItem('el_similarity', similarity); }
    if (style    !== undefined) { _style     = style;       localStorage.setItem('el_style',      style); }
    LOG.info(`[ElevenLabs] Configurado. Voz: ${_voiceId}`);
  }

  // ─── Obtener voces del usuario (API) ─────────
  async function fetchUserVoices() {
    if (!isConfigured()) return [];
    try {
      const res = await fetch(`${API_BASE}/voices`, {
        headers: { 'xi-api-key': _apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.voices || []).map(v => ({
        id:   v.voice_id,
        name: v.name,
        preview_url: v.preview_url || null,
      }));
    } catch (e) {
      LOG.warn('[ElevenLabs] fetchVoices error:', e.message);
      return [];
    }
  }

  // ─── Test de voz ──────────────────────────────
  async function testVoice() {
    return speak(
      'Hola, soy VozUrbana. ¿A dónde quieres ir hoy?',
      () => LOG.info('[ElevenLabs] Test iniciado'),
      () => LOG.info('[ElevenLabs] Test finalizado')
    );
  }

  // ─── API pública ──────────────────────────────
  return {
    isConfigured,
    speak,
    cancel,
    configure,
    fetchUserVoices,
    testVoice,
    get isSpeaking()    { return _isSpeaking; },
    get presetVoices()  { return [...PRESET_VOICES]; },
    get apiKey()        { return _apiKey; },
    get voiceId()       { return _voiceId; },
  };
})();
