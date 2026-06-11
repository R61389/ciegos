# 🦯 VozUrbana Pro — Arquitectura Modular
## Instituto Boliviano de la Ceguera · La Paz, Bolivia

---

## ANÁLISIS DE PROBLEMAS DEL CÓDIGO ANTERIOR

### ❌ Problemas encontrados y soluciones aplicadas

| Problema | Causa | Solución |
|----------|-------|----------|
| Bucle infinito de voz | Mic escuchaba a la IA hablando | Flag `speaking` + apagar mic antes de hablar |
| Gemini falla constantemente | Sin timeout, sin manejo de errores | AbortController, timeout 8s, fallback offline |
| ElevenLabs 401/403 | Permisos de API incorrectos | **Eliminado completamente** |
| Micrófono se cierra solo | Chrome para SpeechRecognition | Reconexión automática con contador de reintentos |
| Múltiples instancias de mic | No se destruía la instancia anterior | `_recognition.stop()` antes de crear nueva |
| Tiempos irreales | OSRM duration no validado | `Math.max(osrmTime, distancia/1.25)` |
| Todo en un archivo | Imposible mantener | **6 módulos separados** |
| Sin offline | Dependencia total de APIs | Respuestas locales completas en `ai.js` |
| Sin manejo de permisos | GPS/mic bloqueaban silenciosamente | Mensajes claros al usuario |
| Google TTS fallaba | API no habilitada en proyecto | **Eliminado, usar Web Speech API** |

---

## ESTRUCTURA DEL PROYECTO

```
vozurbana-pro/
├── index.html          ← HTML limpio (solo estructura)
├── manifest.json       ← PWA instalable
├── css/
│   └── style.css       ← Estilos JARVIS completos
├── js/
│   ├── ui.js           ← Interfaz: reactor, ondas, burbujas
│   ├── voice.js        ← Voz: síntesis + reconocimiento
│   ├── ai.js           ← Gemini + fallback offline
│   ├── map.js          ← Leaflet + OSRM
│   ├── navigation.js   ← GPS, búsqueda, timers
│   └── app.js          ← Controlador principal
└── assets/
    └── (iconos PWA)
```

---

## INSTALAR

```cmd
cd C:\Users\rimer\Downloads\vozurbana-pro
python -m http.server 3000
```
Chrome → `http://localhost:3000`

**Permisos necesarios:** Ubicación y Micrófono → Permitir

---

## ARQUITECTURA ANTI-BUCLE

```
Usuario habla
    ↓
Voice.listen() captura texto
    ↓
App._onVoiceResult() procesa
    ↓
AI.ask() → Gemini o fallback offline
    ↓
Voice.speak() → APAGA mic
    ↓
SpeechSynthesis habla
    ↓
700ms de silencio
    ↓
Voice._resumeMic() → ENCIENDE mic
    ↓
Listo para escuchar de nuevo
```

---

## FLUJO DE NAVEGACIÓN

```
1. Toca pantalla → GPS listo
2. IA pregunta: "¿A dónde quieres ir?"
3. Micrófono activo automáticamente
4. Usuario dice destino
5. AI.normalizePlaceName() → Gemini
6. Navigation.searchPlace() → Nominatim
7. IA confirma: "¿Es este tu destino? Di sí o no"
8. Navigation.checkRoadConditions() → Overpass + OSRM
9. IA informa tiempo real (4.5 km/h correcto)
10. MapEngine.calcRoute() → Leaflet + OSRM
11. Instrucciones por AI.generateNavInstruction() → Gemini
12. Durante nav: silencio total
13. Di "hey asistente" para conversar
14. Di "para" o "llegué" para terminar
```

---

## MODO OFFLINE

Cuando no hay conexión, `ai.js` usa respuestas locales para:
- Saludos y conversación básica
- Navegación (NAV, STOP, REPEAT)
- Emergencias
- Consultas de tiempo restante

---

## WAKE WORDS

Durante la navegación solo responde a:
- "hey asistente"
- "oye asistente"
- "hey vozurbana"
- "hey gemini"

Siempre activos (sin wake word):
- "para" / "stop" / "llegué"

---

## VELOCIDAD PEATONAL CORRECTA

| Distancia | Tiempo real |
|-----------|-------------|
| 500m      | ~7 min      |
| 1 km      | ~13 min     |
| 2 km      | ~27 min     |
| 5 km      | ~67 min     |

Fórmula: `tiempo = max(OSRM_duration, distancia / 1.25)`

---

## RECOMENDACIONES PARA PROYECTO DE GRADO

### Librerías recomendadas
- **Vosk.js** — reconocimiento offline (sin internet)
- **Transformers.js** — IA offline en el navegador
- **Workbox** — Service Worker para PWA avanzado
- **IndexedDB (via idb)** — almacenamiento offline

### Arquitectura futura para IA por voz
```
Usuario → Vosk (STT offline)
         ↓
    Gemini / Llama local
         ↓
    Web Speech API (TTS)
```

### Para proyecto Flutter (siguiente fase)
- `speech_to_text` package
- `flutter_tts` package
- `geolocator` package
- `flutter_map` (Leaflet para Flutter)

---

*VozUrbana Pro — IBC Bolivia · 2025*
*Arquitectura modular lista para proyecto de grado*
