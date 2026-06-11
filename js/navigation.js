/**
 * navigation.js — Módulo de navegación VozUrbana
 * Búsqueda: Photon (principal) + Nominatim (respaldo)
 * GPS real, rutas OSRM peatonales
 * Velocidad peatonal correcta: 4.5 km/h
 */

'use strict';

const Navigation = (() => {

  // ─── Constantes ───────────────────────────────
  const WALK_MPS     = 1.25;   // 4.5 km/h en metros/segundo
  const STEP_RADIUS  = 28;     // metros para avanzar al siguiente paso
  const NOMINATIM_UA = 'VozUrbana-IBC/1.0 (ibc.org.bo)';
  const GPS_OPTS     = { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 };

  // Coordenadas centro de Bolivia para priorizar resultados
  const BOLIVIA_LAT  = -16.5;
  const BOLIVIA_LNG  = -64.0;

  // ─── Estado ───────────────────────────────────
  let _watchId    = null;
  let _stepTimer  = null;
  let _clockTimer = null;
  let _onStep     = null;
  let _onArrived  = null;
  let _onGPS      = null;

  // ─── GPS ──────────────────────────────────────
  function startGPS(onPosition, onError) {
    _onGPS = onPosition;
    if (!navigator.geolocation) {
      LOG.warn('Geolocation no disponible');
      if (onError) onError('no-geolocation');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => _handleGPS(pos, onPosition),
      err => {
        LOG.warn('GPS error inicial:', err.message);
        if (onError) onError(err);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  function watchGPS() {
    if (_watchId !== null) return;
    _watchId = navigator.geolocation.watchPosition(
      pos => {
        AppState.lat = pos.coords.latitude;
        AppState.lng = pos.coords.longitude;
        AppState.acc = Math.round(pos.coords.accuracy);
        if (_onGPS) _onGPS(AppState.lat, AppState.lng, AppState.acc);
        MapEngine.moveUser(AppState.lat, AppState.lng);
      },
      err => LOG.warn('GPS watch error:', err.message),
      GPS_OPTS
    );
    LOG.info('GPS watch iniciado');
  }

  function stopGPS() {
    if (_watchId !== null) {
      navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
  }

  function _handleGPS(pos, cb) {
    AppState.lat   = pos.coords.latitude;
    AppState.lng   = pos.coords.longitude;
    AppState.acc   = Math.round(pos.coords.accuracy);
    AppState.gpsOk = true;
    LOG.info(`GPS: ${AppState.lat.toFixed(5)}, ${AppState.lng.toFixed(5)} ±${AppState.acc}m`);
    if (cb) cb(AppState.lat, AppState.lng, AppState.acc);
  }

  // ═══════════════════════════════════════════════
  //  BÚSQUEDA DE LUGARES
  //  Estrategia: Photon → Nominatim → Nominatim sin Bolivia
  //  Photon es más rápido y reconoce mejor nombres locales
  // ═══════════════════════════════════════════════
  async function searchPlace(rawQuery) {
    LOG.info(`🔍 Buscando: "${rawQuery}"`);

    // Usar coordenadas del usuario si están disponibles
    const userLat = AppState.lat || BOLIVIA_LAT;
    const userLng = AppState.lng || BOLIVIA_LNG;

    // Gemini normaliza el nombre primero
    const normalized = await AI.normalizePlaceName(rawQuery);
    if (normalized !== rawQuery) {
      LOG.info(`Normalizado: "${rawQuery}" → "${normalized}"`);
    }

    // ── 1. Photon — el más rápido y preciso ──
    LOG.info('Intentando Photon...');
    let result = await _photon(normalized, userLat, userLng);
    if (result) {
      LOG.info(`✓ Photon encontró: ${result.name}`);
      return result;
    }

    // Photon con query original si normalizado falló
    if (normalized !== rawQuery) {
      result = await _photon(rawQuery, userLat, userLng);
      if (result) {
        LOG.info(`✓ Photon (original) encontró: ${result.name}`);
        return result;
      }
    }

    // ── 2. Nominatim con Bolivia ──
    LOG.info('Intentando Nominatim...');
    result = await _nominatim(normalized + ' Bolivia');
    if (result) {
      LOG.info(`✓ Nominatim encontró: ${result.name}`);
      return result;
    }

    result = await _nominatim(rawQuery + ' Bolivia');
    if (result) {
      LOG.info(`✓ Nominatim (original) encontró: ${result.name}`);
      return result;
    }

    // ── 3. Nominatim sin restricción de país ──
    result = await _nominatim(normalized);
    if (result) {
      LOG.info(`✓ Nominatim (sin país) encontró: ${result.name}`);
      return result;
    }

    LOG.warn(`✗ Lugar no encontrado: "${rawQuery}"`);
    return null;
  }

  // ─── Photon — motor de geocoding de OpenStreetMap ──
  // Mucho mejor que Nominatim para nombres parciales y locales
  async function _photon(query, lat, lng) {
    try {
      const params = new URLSearchParams({
        q:     query,
        limit: '5',
        lang:  'es',
      });
      if (lat && lng) {
        params.set('lat', lat.toFixed(6));
        params.set('lon', lng.toFixed(6));
      }

      const url = `https://photon.komoot.io/api/?${params}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.features?.length) return null;

      // Filtrar para priorizar resultados de Bolivia
      const features = data.features;
      const bolivian  = features.filter(f =>
        f.properties?.country === 'Bolivia' ||
        f.properties?.countrycode === 'BO'
      );

      // Usar resultados bolivianos primero, luego cualquier resultado
      const best = bolivian.length > 0 ? bolivian[0] : features[0];
      const props = best.properties;
      const coords = best.geometry.coordinates; // [lng, lat]

      // Construir nombre legible
      const nameParts = [
        props.name,
        props.city || props.town || props.village,
        props.state,
      ].filter(Boolean);

      const name = nameParts.slice(0, 2).join(', ');

      return {
        name:     name || props.name || query,
        fullName: nameParts.join(', '),
        lat:      coords[1],
        lng:      coords[0],
        source:   'photon',
      };
    } catch (e) {
      LOG.debug('Photon error:', e.message);
      return null;
    }
  }

  // ─── Nominatim — respaldo ──────────────────────
  async function _nominatim(query) {
    try {
      const params = new URLSearchParams({
        q:              query,
        format:         'json',
        limit:          '3',
        'accept-language': 'es',
        addressdetails: '1',
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {
          headers: {
            'User-Agent':      NOMINATIM_UA,
            'Accept-Language': 'es',
          },
          signal: AbortSignal.timeout(6000),
        }
      );

      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.length) return null;

      const p = data[0];
      return {
        name:     p.display_name.split(',').slice(0, 2).join(', ').trim(),
        fullName: p.display_name,
        lat:      parseFloat(p.lat),
        lng:      parseFloat(p.lon),
        source:   'nominatim',
      };
    } catch (_) {
      return null;
    }
  }

  // ─── Verificar condiciones del camino ─────────
  async function checkRoadConditions(place) {
    const notes = [];

    // Overpass API — obras y restricciones reales en OSM
    try {
      const R = 0.007;
      const bb = `${place.lat-R},${place.lng-R},${place.lat+R},${place.lng+R}`;
      const q  = `[out:json][timeout:6];(way["highway"]["construction"](${bb});way["highway"]["access"="no"](${bb});)out body;`;

      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body:   'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(7000),
      });

      if (res.ok) {
        const d = await res.json();
        if (d.elements?.length > 0) {
          notes.push(`${d.elements.length} posible${d.elements.length > 1 ? 's' : ''} restricción${d.elements.length > 1 ? 'es' : ''} en el camino`);
          LOG.info(`Overpass: ${d.elements.length} restricciones`);
        }
      }
    } catch (e) {
      LOG.debug('Overpass no disponible:', e.message);
    }

    // OSRM — tiempo y distancia real
    let dist = null, timeSec = null;
    try {
      const url = `https://router.project-osrm.org/route/v1/foot/${AppState.lng},${AppState.lat};${place.lng},${place.lat}?overview=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

      if (res.ok) {
        const d = await res.json();
        if (d.code === 'Ok' && d.routes?.[0]) {
          dist    = d.routes[0].distance;
          timeSec = Math.max(
            d.routes[0].duration,
            Math.round(dist / WALK_MPS)
          );
          LOG.info(`OSRM: ${Utils.fmtDistSh(dist)}, ${Utils.fmtTimeSp(timeSec)}`);
        }
      }
    } catch (e) {
      LOG.warn('OSRM error:', e.message);
    }

    return { notes, dist, timeSec };
  }

  // ─── Timers ───────────────────────────────────
  function startTimers(onTick) {
    AppState.elapsed = 0;
    clearInterval(_clockTimer);
    clearInterval(_stepTimer);

    _clockTimer = setInterval(() => {
      AppState.elapsed++;
      AppState.remSec = Math.max(0, AppState.totalSec - AppState.elapsed);
      if (onTick) onTick(AppState.elapsed, AppState.remSec);
    }, 1000);

    _stepTimer = setInterval(_checkStepAdvance, 3500);
  }

  function stopTimers() {
    clearInterval(_clockTimer);
    clearInterval(_stepTimer);
    _clockTimer = null;
    _stepTimer  = null;
  }

  // ─── Verificar avance de paso ─────────────────
  async function _checkStepAdvance() {
    if (!AppState.navOn || !AppState.steps?.length) return;
    if (AppState.stepIdx >= AppState.steps.length - 1) return;

    const next = AppState.steps[AppState.stepIdx + 1];
    if (!next?.waypoint) return;

    const dist = _haversine(
      AppState.lat, AppState.lng,
      next.waypoint.lat, next.waypoint.lng
    );

    if (dist < STEP_RADIUS) {
      AppState.stepIdx++;

      const rem = AppState.steps
        .slice(AppState.stepIdx)
        .reduce((s, x) => s + (x.distance || 0), 0);

      const step = AppState.steps[AppState.stepIdx];
      const inst = await AI.generateNavInstruction(
        step, false,
        Utils.fmtDistSp(rem),
        Utils.fmtTimeSp(AppState.remSec)
      );

      LOG.info(`Paso ${AppState.stepIdx}: ${inst}`);
      if (_onStep) _onStep(inst, step, rem);

      if (rem < 30) {
        setTimeout(() => {
          if (_onStep) _onStep('El destino está a pocos metros.', null, 0);
        }, 2000);
      }

      if (step.type === 'DestinationReached') {
        setTimeout(() => { if (_onArrived) _onArrived(); }, 3000);
      }
    }
  }

  // ─── Haversine ────────────────────────────────
  function _haversine(lat1, lng1, lat2, lng2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
      Math.cos(lat1 * Math.PI/180) *
      Math.cos(lat2 * Math.PI/180) *
      Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── API pública ──────────────────────────────
  return {
    startGPS,
    watchGPS,
    stopGPS,
    searchPlace,
    checkRoadConditions,
    startTimers,
    stopTimers,

    setCallbacks(onStep, onArrived, onGPS) {
      _onStep    = onStep;
      _onArrived = onArrived;
      _onGPS     = onGPS;
    },

    calcRealTime(distMeters) {
      return Math.round(distMeters / WALK_MPS);
    },
  };

})();
