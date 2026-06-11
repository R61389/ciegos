/**
 * map.js — Motor de mapa Leaflet VozUrbana
 * OpenStreetMap + OSRM routing + marcadores
 */

'use strict';

const MapEngine = (() => {

  // ─── Estado ───────────────────────────────────
  let _map       = null;
  let _route     = null;
  let _userMk    = null;
  let _destMk    = null;
  let _onRoute   = null;   // callback cuando ruta calculada
  let _onError   = null;   // callback en error de ruta

  // ─── Crear marcador SVG personalizado ─────────
  function _userIcon() {
    return L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#00ff88;
        box-shadow:0 0 0 5px rgba(0,255,136,.25),
                   0 0 0 10px rgba(0,255,136,.1),
                   0 0 20px rgba(0,255,136,.7);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  function _destIcon() {
    return L.divIcon({
      className: '',
      html: `<div style="
        width:20px;height:20px;
        border-radius:50% 50% 50% 0;
        background:#ffd060;
        transform:rotate(-45deg);
        box-shadow:0 0 16px rgba(255,200,60,.9);
      "></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 20],
    });
  }

  // ─── Inicializar mapa ─────────────────────────
  function init(containerId, lat, lng) {
    if (_map) return; // ya inicializado

    _map = L.map(containerId, {
      zoomControl:        false,
      attributionControl: false,
    }).setView([lat, lng], 17);

    // Tiles oscuros JARVIS (CartoDB Dark Matter — gratis)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom:    20,
    }).addTo(_map);

    // Marcador usuario
    _userMk = L.marker([lat, lng], {
      icon:          _userIcon(),
      zIndexOffset:  1000,
    }).addTo(_map);

    LOG.info(`Mapa inicializado en ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  }

  // ─── Calcular y mostrar ruta ──────────────────
  function calcRoute(destLat, destLng, callbacks) {
    if (!_map) { LOG.warn('Mapa no inicializado'); return; }

    _onRoute = callbacks?.onRoute;
    _onError = callbacks?.onError;
    _clearRoute();

    _destMk = L.marker([destLat, destLng], { icon: _destIcon() }).addTo(_map);

    const mapsKey = localStorage.getItem('maps_key');
    if (mapsKey) {
      _calcRouteGoogle(destLat, destLng, mapsKey);
    } else {
      _calcRouteOSRM(destLat, destLng);
    }
  }

  // ─── Ruta con Google Directions ───────────────
  async function _calcRouteGoogle(destLat, destLng, key) {
    try {
      const params = new URLSearchParams({
        origin:      `${AppState.lat},${AppState.lng}`,
        destination: `${destLat},${destLng}`,
        mode:        'walking',
        language:    'es',
        key,
      });
      const res  = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
      const data = await res.json();

      if (data.status !== 'OK' || !data.routes?.length) {
        LOG.warn('Google Directions falló, usando OSRM');
        _calcRouteOSRM(destLat, destLng);
        return;
      }

      const route = data.routes[0];
      const leg   = route.legs[0];

      // Dibujar polyline decodificada
      const points = _decodePolyline(route.overview_polyline.points);
      const poly = L.polyline(points, {
        color:     'rgba(0,220,255,0.78)',
        weight:    4,
        dashArray: '14 7',
      }).addTo(_map);
      const polyBg = L.polyline(points, {
        color:  'rgba(0,200,255,0.1)',
        weight: 24,
      }).addTo(_map);
      _map.fitBounds(poly.getBounds(), { padding: [40, 40] });

      // Construir steps compatibles con el resto de la app
      const steps = leg.steps.map(s => ({
        type:        s.maneuver || 'continue',
        modifier:    s.maneuver || '',
        road:        s.html_instructions.replace(/<[^>]+>/g, ''),
        distance:    s.distance.value,
        duration:    s.duration.value,
        instruction: s.html_instructions.replace(/<[^>]+>/g, ''),
      }));

      const totalDist = leg.distance.value;
      const realSec   = Navigation.calcRealTime(totalDist);
      const useSec    = Math.max(leg.duration.value, realSec);

      AppState.steps    = steps;
      AppState.stepIdx  = 0;
      AppState.totalSec = useSec;
      AppState.remSec   = useSec;

      // Guardar referencia para limpiar después
      _route = { _polylines: [poly, polyBg], remove: () => { poly.remove(); polyBg.remove(); } };

      if (_onRoute) _onRoute({ summary: { totalDistance: totalDist, totalTime: useSec } }, useSec);

    } catch (e) {
      LOG.warn('Error Google Directions:', e.message);
      _calcRouteOSRM(destLat, destLng);
    }
  }

  // ─── Ruta con OSRM (fallback) ─────────────────
  function _calcRouteOSRM(destLat, destLng) {
    _route = L.Routing.control({
      waypoints: [
        L.latLng(AppState.lat, AppState.lng),
        L.latLng(destLat, destLng),
      ],
      router: L.Routing.osrmv1({
        serviceUrl: 'https://router.project-osrm.org/route/v1',
        profile:    'foot',
      }),
      lineOptions: {
        styles: [
          { color: 'rgba(0,200,255,0.1)',  weight: 24 },
          { color: 'rgba(0,220,255,0.78)', weight: 4, dashArray: '14 7' },
        ],
        extendToWaypoints:    false,
        missingRouteTolerance: 0,
      },
      createMarker:       () => null,
      addWaypoints:       false,
      routeWhileDragging: false,
      fitSelectedRoutes:  true,
      show:               false,
    }).addTo(_map);

    _route.on('routesfound', (e) => {
      const rt    = e.routes[0];
      const realSec = Navigation.calcRealTime(rt.summary.totalDistance);
      const useSec  = Math.max(rt.summary.totalTime, realSec);
      AppState.steps    = rt.instructions;
      AppState.stepIdx  = 0;
      AppState.totalSec = useSec;
      AppState.remSec   = useSec;
      if (_onRoute) _onRoute(rt, useSec);
    });

    _route.on('routingerror', (e) => {
      LOG.warn('Error OSRM:', e.error?.message);
      if (_onError) _onError(e);
    });
  }

  // ─── Decodificar polyline de Google ───────────
  function _decodePolyline(encoded) {
    const pts = [];
    let idx = 0, lat = 0, lng = 0;
    while (idx < encoded.length) {
      let b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  }

  function _clearRoute() {
    if (_route) {
      if (typeof _route.remove === 'function') _route.remove();
      else if (typeof _route.removeFrom === 'function' && _map) _map.removeControl(_route);
      _route = null;
    }
    if (_destMk && _map) {
      _map.removeLayer(_destMk);
      _destMk = null;
    }
  }

  // ─── Mover marcador usuario ───────────────────
  function moveUser(lat, lng) {
    if (!_map || !_userMk) return;
    _userMk.setLatLng([lat, lng]);
    if (AppState.navOn) _map.panTo([lat, lng]);
  }

  // ─── Mostrar/ocultar mapa ─────────────────────
  function show() {
    const el = document.getElementById('map');
    if (el) el.classList.add('on');
    if (_map) setTimeout(() => _map.invalidateSize(), 300);
  }

  function hide() {
    const el = document.getElementById('map');
    if (el) el.classList.remove('on');
  }

  // ─── Destruir mapa ────────────────────────────
  function destroy() {
    _clearRoute();
    if (_userMk && _map) _map.removeLayer(_userMk);
    if (_map) { _map.remove(); _map = null; }
    _userMk = null;
  }

  // ─── API pública ──────────────────────────────
  return { init, calcRoute, moveUser, show, hide, destroy };

})();
