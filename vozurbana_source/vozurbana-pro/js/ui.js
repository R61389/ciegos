/**
 * ui.js — Módulo de interfaz VozUrbana
 * JARVIS reactor, ondas de voz, burbujas, HUD
 */

'use strict';

const UI = (() => {

  // ─── Timers ───────────────────────────────────
  let _waveInterval  = null;
  let _aiBblTimer    = null;
  let _usrBblTimer   = null;
  let _reactorFrames = [];

  const $ = id => document.getElementById(id);

  // ═══════════════════════════════════════════
  //  REACTOR CANVAS — animación JARVIS
  // ═══════════════════════════════════════════
  function initReactor(canvasId) {
    const canvas = $(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const CX = W / 2, CY = H / 2;
    let frame = 0;

    const orbs = Array.from({ length: 12 }, (_, i) => ({
      angle: (i / 12) * Math.PI * 2,
      radius: W * 0.25 + (i % 3) * W * 0.06,
      speed: 0.012 + (i % 4) * 0.004,
      size: 1.2 + (i % 3) * 0.7,
      alpha: 0.35 + (i % 4) * 0.15,
    }));

    function hexPoints(r, rot) {
      return Array.from({ length: 6 }, (_, i) => {
        const a = rot + i * Math.PI / 3;
        return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
      });
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      const t = frame * 0.016;
      const p = 0.7 + 0.3 * Math.sin(t * 1.8);
      const rad = W * 0.4;

      // Fondo
      ctx.beginPath(); ctx.arc(CX, CY, rad, 0, Math.PI * 2);
      ctx.fillStyle = '#000c28'; ctx.fill();

      // Borde exterior
      ctx.beginPath(); ctx.arc(CX, CY, rad, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,180,255,${0.22 * p})`; ctx.lineWidth = 2; ctx.stroke();

      // Gradiente central
      const g = ctx.createRadialGradient(CX - W * 0.05, CY - H * 0.05, 4, CX, CY, W * 0.32);
      g.addColorStop(0,   `rgba(180,240,255,${0.8 * p})`);
      g.addColorStop(0.3, `rgba(0,200,255,${0.7 * p})`);
      g.addColorStop(0.7, `rgba(0,80,200,${0.5 * p})`);
      g.addColorStop(1,   'rgba(0,10,40,0)');
      ctx.beginPath(); ctx.arc(CX, CY, W * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();

      // Hexágonos giratorios
      [
        [W * 0.21,  t * 0.6,             1.5, `rgba(0,220,255,${0.5 * p})`],
        [W * 0.14, -t * 0.9 + Math.PI/6, 1.0, `rgba(100,230,255,${0.65 * p})`],
      ].forEach(([r, rot, lw, sc]) => {
        const pts = hexPoints(r, rot);
        ctx.beginPath();
        pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
        ctx.closePath();
        ctx.strokeStyle = sc; ctx.lineWidth = lw; ctx.stroke();
      });

      // Punto central
      ctx.beginPath(); ctx.arc(CX, CY, W * 0.028 * p, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,250,255,${p})`; ctx.fill();

      // Pulso exterior
      ctx.beginPath();
      ctx.arc(CX, CY, rad + W * 0.06 * Math.abs(Math.sin(t * 0.8)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,200,255,${0.07 * p})`; ctx.lineWidth = 9; ctx.stroke();

      // Orbitales
      orbs.forEach(orb => {
        orb.angle += orb.speed;
        ctx.beginPath();
        ctx.arc(CX + orb.radius * Math.cos(orb.angle), CY + orb.radius * Math.sin(orb.angle), orb.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,210,255,${orb.alpha})`; ctx.fill();
      });

      frame++;
      const rafId = requestAnimationFrame(draw);
      _reactorFrames.push(rafId);
    }

    draw();
  }

  // ═══════════════════════════════════════════
  //  PARTÍCULAS DE FONDO
  // ═══════════════════════════════════════════
  function initParticles(canvasId) {
    const canvas = $(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, pts = [];

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    }

    function init() {
      resize();
      pts = Array.from({ length: 65 }, () => ({
        x:  Math.random() * W,
        y:  Math.random() * H,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r:  Math.random() * 1.5 + 0.3,
        a:  Math.random() * 0.42 + 0.1,
      }));
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#000510'; ctx.fillRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;

      pts.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        const d = Math.hypot(p.x - cx, p.y - cy);
        const fade = Math.max(0, 1 - d / 290);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,190,255,${p.a * fade})`; ctx.fill();
      });

      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (d < 80) {
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = `rgba(0,175,255,${0.12 * (1 - d / 80)})`;
            ctx.lineWidth = 0.5; ctx.stroke();
          }
        }
      }
      requestAnimationFrame(draw);
    }

    init(); draw();
    window.addEventListener('resize', init);
  }

  // ═══════════════════════════════════════════
  //  ONDA DE VOZ
  // ═══════════════════════════════════════════
  function startWave() {
    const wave = $('vwave');
    const lbl  = $('vlbl');
    if (wave) wave.classList.add('on');
    if (lbl)  lbl.classList.add('on');
    setDot('spk');

    clearInterval(_waveInterval);
    _waveInterval = setInterval(() => {
      document.querySelectorAll('.vb').forEach((b, i) => {
        b.style.height = (6 + Math.sin(Date.now() / 175 + i * 0.9) * 12 + Math.random() * 16) + 'px';
      });
    }, 80);
  }

  function stopWave() {
    clearInterval(_waveInterval);
    const wave = $('vwave');
    const lbl  = $('vlbl');
    if (wave) wave.classList.remove('on');
    if (lbl)  lbl.classList.remove('on');
    document.querySelectorAll('.vb').forEach(b => b.style.height = '6px');
    setDot('');
  }

  // ═══════════════════════════════════════════
  //  BURBUJAS FLOTANTES
  // ═══════════════════════════════════════════
  function showAIBubble(text) {
    const el = $('aibbl');
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(_aiBblTimer);
    _aiBblTimer = setTimeout(() => el.classList.remove('on'), Math.max(4000, text.length * 60));
    announce(text);
  }

  function showUserBubble(text) {
    const el = $('usrbbl');
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(_usrBblTimer);
    _usrBblTimer = setTimeout(() => el.classList.remove('on'), 3000);
  }

  function showTyping(on) {
    const el = $('ftyp');
    if (el) el.classList.toggle('on', on);
  }

  // ═══════════════════════════════════════════
  //  CAJA DE CONFIRMACIÓN
  // ═══════════════════════════════════════════
  function showConfirm(placeName) {
    const el = $('cfbox');
    const nm = $('cfplace');
    if (nm) nm.textContent = placeName;
    if (el) el.classList.add('on');
  }

  function hideConfirm() {
    const el = $('cfbox');
    if (el) el.classList.remove('on');
  }

  // ═══════════════════════════════════════════
  //  PANTALLAS
  // ═══════════════════════════════════════════
  function showMain() {
    $('s-idle')?.classList.add('off');
    $('s-main')?.classList.remove('off');
  }

  function showNav() {
    $('nvbox')?.classList.add('on');
    $('nvhud')?.classList.add('on');
    $('chatbar')?.classList.add('nm');
    $('wkind')?.classList.add('on');
    $('aibbl')?.classList.add('nm');
    $('usrbbl')?.classList.add('nm');
    $('ftyp')?.classList.add('nm');
    $('vwave')?.classList.add('nm');
    $('jbg')?.classList.add('off');
  }

  function hideNav() {
    $('nvbox')?.classList.remove('on');
    $('nvhud')?.classList.remove('on');
    $('chatbar')?.classList.remove('nm');
    $('wkind')?.classList.remove('on');
    $('aibbl')?.classList.remove('nm');
    $('usrbbl')?.classList.remove('nm');
    $('ftyp')?.classList.remove('nm');
    $('vwave')?.classList.remove('nm');
    $('jbg')?.classList.remove('off');
  }

  // ═══════════════════════════════════════════
  //  INSTRUCCIÓN DE NAVEGACIÓN
  // ═══════════════════════════════════════════
  function updateNavStep(instruction, step, distRem) {
    const arrow = _getArrow(step?.type, step?.modifier);
    const road  = step?.road || '';
    const dist  = Utils.fmtDistSh(step?.distance);

    const arrEl   = $('nvarr');
    const mainEl  = $('nvmain');
    const subEl   = $('nvsub');
    const distEl  = $('nvd');
    const fillEl  = $('nvfill');
    const mDistEl = $('mdist');

    if (arrEl)   arrEl.textContent  = arrow;
    if (mainEl)  mainEl.textContent = instruction;
    if (subEl)   subEl.textContent  = road;
    if (distEl)  distEl.textContent = dist;
    if (mDistEl) mDistEl.textContent = Utils.fmtDistSh(distRem);

    // Barra de progreso
    if (fillEl) {
      fillEl.style.width = '0%';
      setTimeout(() => fillEl.style.width = '100%', 120);
    }
  }

  function updateHUD(elapsed, remSec) {
    const m  = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s  = String(elapsed % 60).padStart(2, '0');
    const mt = $('mtime');
    const me = $('meta');
    if (mt) mt.textContent = `${m}:${s}`;
    if (me) me.textContent = Utils.fmtTimeEta(remSec);
  }

  function _getArrow(type, mod) {
    if (type === 'DestinationReached') return '✅';
    const m = (mod || '').toLowerCase();
    if (m.includes('sharp left'))  return '↩';
    if (m.includes('sharp right')) return '↪';
    if (m.includes('slight left')) return '↖';
    if (m.includes('slight right'))return '↗';
    if (m.includes('left'))        return '↰';
    if (m.includes('right'))       return '↱';
    if (m.includes('uturn'))       return '↺';
    return '⬆';
  }

  // ═══════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════
  function setMid(text)   { const e = $('hmid');   if (e) e.textContent = text; }
  function setGPS(text)   { const e = $('hgps');   if (e) e.textContent = text; }
  function setIdleSt(txt) { const e = $('ist');    if (e) e.textContent = txt;  }

  function setMicStatus(text, active) {
    const dot = $('micdot');
    const lbl = $('miclbl');
    if (dot) dot.className = 'micdot' + (active ? ' act' : '');
    if (lbl && text) lbl.textContent = text;
  }

  function setDot(state) {
    const d = $('micdot');
    if (d) d.className = 'micdot' + (state ? ` ${state}` : '');
  }

  function setWakeActive(active) {
    const wi = $('wkind');
    if (!wi) return;
    if (active) {
      wi.textContent = '✦ Dime...';
      wi.classList.add('aw');
    } else {
      wi.textContent = 'Di «hey asistente» para hablar';
      wi.classList.remove('aw');
    }
  }

  function announce(text) {
    const a = $('ann');
    if (a) a.textContent = text;
  }

  function spawnRipple(x, y) {
    const idle = $('s-idle');
    if (!idle) return;
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.cssText = `left:${x}px;top:${y}px;`;
    idle.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  function updateClock() {
    const n   = new Date();
    const txt = String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
    const el  = $('dhora');
    if (el) el.textContent = txt;
  }

  return {
    initReactor,
    initParticles,
    startWave,
    stopWave,
    showAIBubble,
    showUserBubble,
    showTyping,
    showConfirm,
    hideConfirm,
    showMain,
    showNav,
    hideNav,
    updateNavStep,
    updateHUD,
    setMid,
    setGPS,
    setIdleSt,
    setMicStatus,
    setDot,
    setWakeActive,
    announce,
    spawnRipple,
    updateClock,
  };

})();
