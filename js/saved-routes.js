/**
 * saved-routes.js — Módulo de rutas guardadas VozUrbana
 * Persiste en localStorage, panel de gestión con Motion One
 */

'use strict';

// ═══════════════════════════════════════════════
//  SavedRoutes — almacenamiento y CRUD
// ═══════════════════════════════════════════════
const SavedRoutes = (() => {
  const KEY      = 'voz_saved_routes';
  const MAX      = 20;

  function _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { return []; }
  }
  function _persist(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
  }

  function save(name, lat, lng, distMeters, timeSec) {
    const all  = _load();
    const idx  = all.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    const entry = {
      id:         Date.now(),
      name:       name.trim(),
      lat,
      lng,
      distMeters: distMeters ?? null,
      timeSec:    timeSec    ?? null,
      savedAt:    new Date().toISOString(),
    };

    if (idx >= 0) { all[idx] = entry; }
    else          { all.unshift(entry); if (all.length > MAX) all.pop(); }

    _persist(all);
    LOG.info(`[SavedRoutes] Guardada: "${entry.name}" (${lat?.toFixed(4)}, ${lng?.toFixed(4)})`);
    return entry;
  }

  function remove(id) {
    _persist(_load().filter(r => r.id !== id));
    LOG.info(`[SavedRoutes] Eliminada id=${id}`);
  }

  function getAll()  { return _load(); }
  function count()   { return _load().length; }
  function clear()   { _persist([]); }
  function find(id)  { return _load().find(r => r.id === id) || null; }

  return { save, remove, getAll, count, clear, find };
})();


// ═══════════════════════════════════════════════
//  RoutesPanel — UI del panel de rutas guardadas
// ═══════════════════════════════════════════════
const RoutesPanel = (() => {
  const $ = id => document.getElementById(id);
  let _isOpen = false;

  // ─── Init ─────────────────────────────────────
  function init() {
    $('routes-fab')?.addEventListener('click', toggle);
    $('routes-close')?.addEventListener('click', close);
    $('routes-clear-btn')?.addEventListener('click', _onClear);

    // Actualizar badge al arrancar
    _updateBadge();
    LOG.info('[RoutesPanel] Inicializado');
  }

  // ─── Abrir / cerrar ───────────────────────────
  function open() {
    if (_isOpen) return;
    _isOpen = true;
    const panel = $('routes-panel');
    if (!panel) return;
    panel.classList.add('open');
    _render();
    if (typeof Motion !== 'undefined') {
      Motion.animate(panel,
        { y: ['100%', '0%'], opacity: [0.6, 1] },
        { duration: 0.4, easing: [0.32, 0, 0.25, 1.1] }
      );
    }
  }

  function close() {
    if (!_isOpen) return;
    _isOpen = false;
    const panel = $('routes-panel');
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

  // ─── Renderizar lista ─────────────────────────
  function _render() {
    const list  = $('routes-list');
    const empty = $('routes-empty');
    if (!list) return;

    const routes = SavedRoutes.getAll();

    if (routes.length === 0) {
      list.innerHTML  = '';
      list.style.display = 'none';
      if (empty) empty.style.display = 'flex';
      return;
    }

    if (empty) empty.style.display = 'none';
    list.style.display = 'flex';

    list.innerHTML = routes.map(r => {
      const date = new Date(r.savedAt);
      const when = date.toLocaleDateString('es', { day: '2-digit', month: 'short' }) +
                   ' · ' + date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
      const dist = r.distMeters ? _fmtDist(r.distMeters) : '';
      const time = r.timeSec   ? _fmtTime(r.timeSec)    : '';
      const meta = [dist, time].filter(Boolean).join(' · ');

      return `<div class="rp-row" data-id="${r.id}">
        <div class="rp-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <div class="rp-info">
          <div class="rp-name">${_esc(r.name.split(',')[0].trim())}</div>
          <div class="rp-meta">${meta ? meta + ' · ' : ''}${when}</div>
        </div>
        <div class="rp-actions">
          <button class="rp-nav-btn" data-id="${r.id}" aria-label="Navegar a ${_esc(r.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          </button>
          <button class="rp-del-btn" data-id="${r.id}" aria-label="Eliminar ruta ${_esc(r.name)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    // Eventos delegados
    list.querySelectorAll('.rp-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => _onNavigate(parseInt(btn.dataset.id)));
    });
    list.querySelectorAll('.rp-del-btn').forEach(btn => {
      btn.addEventListener('click', () => _onDelete(parseInt(btn.dataset.id)));
    });
  }

  // ─── Acciones ─────────────────────────────────
  function _onNavigate(id) {
    const route = SavedRoutes.find(id);
    if (!route) return;
    close();
    // Lanzar navegación via AppState + callback global
    if (typeof App !== 'undefined' && App.navigateTo) {
      App.navigateTo(route);
    }
  }

  function _onDelete(id) {
    SavedRoutes.remove(id);
    _render();
    _updateBadge();
  }

  function _onClear() {
    SavedRoutes.clear();
    _render();
    _updateBadge();
  }

  function _updateBadge() {
    const n   = SavedRoutes.count();
    const fab = $('routes-fab');
    const b   = $('routes-badge');
    if (b) {
      b.textContent    = n > 99 ? '99+' : n;
      b.style.display  = n > 0 ? 'flex' : 'none';
    }
    if (fab) fab.dataset.count = n;
  }

  // ─── Agregar ruta (llamado desde app.js) ──────
  function addRoute(name, lat, lng, distMeters, timeSec) {
    const entry = SavedRoutes.save(name, lat, lng, distMeters, timeSec);
    _updateBadge();

    // Toast de confirmación
    _showToast(`✓ Guardada: ${name.split(',')[0].trim()}`);
    return entry;
  }

  function _showToast(msg) {
    const t = $('routes-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    if (typeof Motion !== 'undefined') {
      Motion.animate(t, { y: ['20px', '0px'], opacity: [0, 1] }, { duration: 0.3, easing: [0.34, 1.56, 0.64, 1] });
    }
    setTimeout(() => {
      if (typeof Motion !== 'undefined') {
        Motion.animate(t, { opacity: [1, 0] }, { duration: 0.25 }).then(() => t.classList.remove('on'));
      } else {
        t.classList.remove('on');
      }
    }, 2800);
  }

  // ─── Utils ────────────────────────────────────
  function _fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }
  function _fmtTime(s) {
    const m = Math.ceil(s / 60);
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m} min`;
  }
  function _esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, open, close, toggle, addRoute, refresh: _render };
})();
