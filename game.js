/*
 * game.js — Modalità gioco con supporto target mobili.
 *
 * ARCHITETTURA:
 *   Carica la mappa da map.json (default) o da base64 incollato dall'utente.
 *   Il giocatore punta il cannone (centro-alto del canvas) e spara palline
 *   cliccando sul canvas. La preview della traiettoria segue il mouse in tempo reale.
 *
 * GAME CLOCK:
 *   Un loop requestAnimationFrame continuo (startGameClock) mantiene `gameClock`
 *   aggiornato. Serve per:
 *   - Animare i target mobili (posizione = f(gameClock))
 *   - Ricalcolare la preview se ci sono target mobili e il mouse è sul canvas
 *
 * TEMPORIZZAZIONE:
 *   - Idle (mouse su canvas): targetTime = gameClock
 *   - Durante animazione palla: targetTime = fireGlobalTime + physicalElapsed
 *     (physicalElapsed = tempo fisico nel frame della traiettoria)
 *   Questo garantisce che target e preview siano sincronizzati.
 *
 * FLUSSO TIRO:
 *   1. Click → salva fireGlobalTime = gameClock
 *   2. Calcola traiettoria con computeTrajectorySegments(..., fireGlobalTime)
 *   3. Anima la palla frame-by-frame con getPositionAtPhysicalTime
 *   4. A fine animazione: segna target colpiti come removed, aggiorna score
 *
 * DIPENDENZE: engine.js, mapLoader.js, motion.js
 * FILE HTML: game.html
 */
import * as Engine from './engine.js';
import { loadMap } from './mapLoader.js';
import { getTargetPositionAtTime } from './motion.js';

const canvas = document.getElementById('gameCanvas');
const statusEl = document.getElementById('status');

/* ---------- Stato del gioco ---------- */
let state = {
  params: {},              // Parametri fisici e di gioco (da mappa)
  targets: [],             // Array di target (con .hit, .removed, .motion)
  previewSegments: null,   // Segmenti traiettoria troncati (per preview)
  previewSamples: null,    // Punti campionati della preview
  fullSegments: null,      // Segmenti traiettoria completa (per animazione)
  fullSamples: null,       // Punti campionati completi
  mousePos: { x: 0, y: 0 },
  mouseOnCanvas: false,
  lastMouseAngle: null,    // Angolo dal cannone al mouse (radianti)
  animating: false,        // true durante animazione palla
  shotsLeft: 0,
  score: 0,
  cannon: { x: 0, y: 40 }, // Posizione del cannone (centro-alto)
  // Game clock per target mobili
  gameClock: 0,            // Tempo globale in secondi
  gameClockStart: 0,       // performance.now() all'inizio
  gameClockRunning: false,
  hasMovingTargets: false,  // true se almeno un target ha motion
  // Timing animazione palla
  fireGlobalTime: 0,       // gameClock al momento del tiro
  currentPhysicalTime: 0   // Tempo fisico corrente nell'animazione
};

/* ---------- CSS custom properties helper ---------- */
function getGameStyleVars(){
  const s = getComputedStyle(document.documentElement);
  const parseLineDash = (str) => {
    const parts = (str || '').trim().split(/\s+/).map(n => Number(n));
    return parts.length ? parts : [6,6];
  };
  return {
    cannon: s.getPropertyValue('--game-cannon').trim() || '#999',
    target: s.getPropertyValue('--game-target').trim() || '#0af',
    targetHit: s.getPropertyValue('--game-target-hit').trim() || '#ff0',
    preview: s.getPropertyValue('--game-preview').trim() || 'rgba(255,255,255,0.6)',
    previewMarker: s.getPropertyValue('--game-preview-marker').trim() || '#ff8',
    ball: s.getPropertyValue('--game-ball').trim() || '#f55',
    ground: s.getPropertyValue('--game-ground').trim() || '#444',
    wall: s.getPropertyValue('--game-wall').trim() || '#666',
    hud: s.getPropertyValue('--game-hud').trim() || '#ddd',
    hudFont: s.getPropertyValue('--game-hud-font').trim() || '14px Arial',
    lineDash: parseLineDash(s.getPropertyValue('--game-line-dash'))
  };
}

/* ---------- Status bar ---------- */
function updateStatus(t){ statusEl.textContent = t; }

/* ---------- Tempo target per rendering ---------- */
/** Ritorna il tempo globale da usare per posizionare i target. */
function getTargetTime(){
  if(state.animating) return state.fireGlobalTime + state.currentPhysicalTime;
  return state.gameClock;
}

/* ---------- Drawing ---------- */
/**
 * Disegna l'intera scena: cannone, pareti, target, preview, palla, ground, HUD.
 * @param {number|null} ballX - Posizione palla (null se non visibile)
 * @param {number|null} ballY
 * @param {Array|null} preview - Punti preview da disegnare
 */
function drawScene(ballX = null, ballY = null, preview = null){
  const ctx = canvas.getContext('2d');
  const style = getGameStyleVars();
  const targetTime = getTargetTime();

  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Cannone (cerchio grigio in alto al centro)
  ctx.fillStyle = style.cannon;
  ctx.beginPath(); ctx.arc(state.cannon.x, state.cannon.y, 14,0,Math.PI*2); ctx.fill();

  // Soffitto e pareti
  ctx.strokeStyle = style.wall; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, state.params.ballRadius); ctx.lineTo(canvas.width, state.params.ballRadius);
  ctx.moveTo(state.params.ballRadius, 0); ctx.lineTo(state.params.ballRadius, canvas.height);
  ctx.moveTo(canvas.width - state.params.ballRadius, 0); ctx.lineTo(canvas.width - state.params.ballRadius, canvas.height);
  ctx.stroke();

  // Target — posizionati al tempo corrente (mobili o statici)
  for(const t of state.targets){
    if(t.removed) continue;
    const pos = getTargetPositionAtTime(t, targetTime);
    if(t.shape === 'rect'){
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate((t.angle || 0) * Math.PI / 180);
      ctx.fillStyle = t.hit ? style.targetHit : style.target;
      ctx.beginPath();
      ctx.rect(-t.width/2, -t.height/2, t.width, t.height);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = t.hit ? style.targetHit : style.target;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, t.r,0,Math.PI*2); ctx.fill();
    }
  }

  // Preview traiettoria (linea tratteggiata + marker ai rimbalzi)
  if(!state.animating && preview && preview.length){
    ctx.save();
    ctx.strokeStyle = style.preview;
    ctx.setLineDash(style.lineDash);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for(let i=0;i<preview.length;i++){
      const p = preview[i];
      if(i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = style.previewMarker;
    for(const p of preview){
      if(p.event === 'target' || p.event === 'wall' || p.event === 'ceiling'){
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI*2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // Palla (durante animazione)
  if(typeof ballX === 'number'){
    ctx.fillStyle = style.ball;
    ctx.beginPath(); ctx.arc(ballX, ballY, state.params.ballRadius,0,Math.PI*2); ctx.fill();
  }

  // Ground
  ctx.strokeStyle = style.ground;
  ctx.beginPath(); ctx.moveTo(0, canvas.height - 20); ctx.lineTo(canvas.width, canvas.height - 20); ctx.stroke();

  // HUD (tiri rimasti + punteggio)
  ctx.fillStyle = style.hud;
  ctx.font = style.hudFont || '14px Arial';
  ctx.fillText(`Tiri rimasti: ${state.shotsLeft}   Punteggio: ${state.score}`, 12, 18);
}

/* ---------- Max Bounces ---------- */
/** Applica il limite di rimbalzi ai segmenti (per preview troncata). */
function applyMaxBouncesToSegments(segments){
  const maxB = state.params.maxBounces || 0;
  if(!segments) return segments;
  if(!maxB || maxB <= 0) return segments;
  return Engine.truncateSegmentsByBounces(segments, maxB);
}

/* ---------- Preview traiettoria ---------- */
/** Ricalcola la preview dal cannone verso l'angolo del mouse. */
function recomputePreview(){
  if(state.animating || state.lastMouseAngle === null) return;
  const speed = state.params.defaultSpeed;
  const ang = state.lastMouseAngle;
  const vx = speed * Math.cos(ang);
  const vy = speed * Math.sin(ang);
  const params = {
    gravity: state.params.gravity,
    restitution: state.params.restitution,
    ballRadius: state.params.ballRadius,
    canvasWidth: state.params.canvasWidth,
    canvasHeight: state.params.canvasHeight,
    targets: state.targets
  };
  // Passa gameClock come globalStartTime per sincronizzare con target mobili
  const fullSegs = Engine.computeTrajectorySegments(state.cannon.x, state.cannon.y, vx, vy, params, state.gameClock);
  const previewSegs = applyMaxBouncesToSegments(fullSegs);
  state.previewSegments = previewSegs;
  state.previewSamples = Engine.sampleTrajectory(previewSegs, state.params.samples, params);
}

/* ---------- Game clock (loop continuo) ---------- */
/** Avvia il game clock. Aggiorna gameClock e ridisegna se ci sono target mobili. */
function startGameClock(){
  state.gameClockStart = performance.now();
  state.gameClockRunning = true;

  function tick(now){
    if(!state.gameClockRunning) return;
    state.gameClock = (now - state.gameClockStart) / 1000;

    // Se non stiamo animando e ci sono target mobili, aggiorna preview e ridisegna
    if(!state.animating && state.hasMovingTargets){
      if(state.mouseOnCanvas) recomputePreview();
      drawScene(null, null, state.previewSamples);
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- Input handlers ---------- */
function attachInputHandlers(){
  canvas.addEventListener('mouseenter', () => { state.mouseOnCanvas = true; });
  canvas.addEventListener('mouseleave', () => { state.mouseOnCanvas = false; });

  // Mousemove: aggiorna angolo e ricalcola preview
  canvas.addEventListener('mousemove', (e)=>{
    if(state.animating) return;
    const rect = canvas.getBoundingClientRect();
    state.mousePos.x = e.clientX - rect.left;
    state.mousePos.y = e.clientY - rect.top;
    // Angolo dal cannone al cursore
    state.lastMouseAngle = Math.atan2(state.mousePos.y - state.cannon.y, state.mousePos.x - state.cannon.x);

    recomputePreview();

    // Ridisegna solo se non c'è il game clock attivo (target statici)
    if(!state.hasMovingTargets){
      drawScene(null, null, state.previewSamples);
    }
  });

  // Click: spara la palla
  canvas.addEventListener('click', (e)=>{
    if(state.animating){ updateStatus('Animazione in corso'); return; }
    if(state.shotsLeft <= 0){ updateStatus('Nessun tiro rimasto'); return; }

    const rect = canvas.getBoundingClientRect();
    state.mousePos.x = e.clientX - rect.left;
    state.mousePos.y = e.clientY - rect.top;
    const speed = state.params.defaultSpeed;
    const ang = Math.atan2(state.mousePos.y - state.cannon.y, state.mousePos.x - state.cannon.x);
    const vx = speed * Math.cos(ang);
    const vy = speed * Math.sin(ang);
    const params = {
      gravity: state.params.gravity,
      restitution: state.params.restitution,
      ballRadius: state.params.ballRadius,
      canvasWidth: state.params.canvasWidth,
      canvasHeight: state.params.canvasHeight,
      targets: state.targets
    };

    // Salva il tempo globale al momento del tiro (per sincronizzazione target mobili)
    state.fireGlobalTime = state.gameClock;

    // Calcola traiettoria completa e preview troncata
    const fullSegs = Engine.computeTrajectorySegments(state.cannon.x, state.cannon.y, vx, vy, params, state.fireGlobalTime);
    const fullSamples = Engine.sampleTrajectory(fullSegs, Math.max(state.params.samples, 200), params);
    const previewSegs = applyMaxBouncesToSegments(fullSegs);
    const previewSamples = Engine.sampleTrajectory(previewSegs, state.params.samples, params);

    state.fullSegments = fullSegs;
    state.fullSamples = fullSamples;
    state.previewSegments = previewSegs;
    state.previewSamples = previewSamples;

    if(!state.fullSegments || state.fullSegments.length === 0 || !state.fullSamples || state.fullSamples.length === 0){
      updateStatus('Impossibile calcolare traiettoria');
      return;
    }

    // Durata fisica totale e durata animazione (scalata da timeScale)
    const totalPhysicalTime = state.fullSegments[state.fullSegments.length - 1].t1 || 0.0001;
    const animationDuration = Math.max(0.02, totalPhysicalTime * state.params.timeScale);

    // Reset hit su tutti i target
    for(const t of state.targets) if(!t.removed) t.hit = false;

    state.shotsLeft--; updateStatus('Animazione in corso');

    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = 'wait';
    state.animating = true;
    state.currentPhysicalTime = 0;
    const startWall = performance.now();

    // Loop animazione frame-by-frame
    function frame(now){
      const wallElapsed = (now - startWall) / 1000;
      const progress = Math.min(1, wallElapsed / animationDuration);
      // Mappa progresso wall-clock → tempo fisico
      const physicalElapsed = progress * totalPhysicalTime;
      state.currentPhysicalTime = physicalElapsed;

      const pos = Engine.getPositionAtPhysicalTime(state.fullSegments, physicalElapsed, state.params.gravity);
      if(!pos){
        state.animating = false;
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        updateStatus('Errore animazione');
        drawScene();
        return;
      }

      // Marca target colpiti (con flash giallo temporaneo)
      for(const s of state.fullSegments){
        if(s.event === 'target' && s.targetRef && !s.targetRef.removed && !s.targetRef.hit){
          if(physicalElapsed >= s.t1 - 1e-6){
            s.targetRef.hit = true;
            setTimeout((targ)=>{ if(!targ.removed) targ.hit = false; }, 260, s.targetRef);
          }
        }
      }

      drawScene(pos.x, pos.y, null);

      if(progress < 1) requestAnimationFrame(frame);
      else {
        // Fine animazione: rimuovi target colpiti, aggiorna score
        for(const t of state.targets){
          if(t.hit && !t.removed){
            state.score += 100;
            t.removed = true;
          }
        }
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        updateStatus('Pronto');
        state.animating = false;
        state.currentPhysicalTime = 0;
        state.previewSegments = null;
        state.previewSamples = null;
        state.fullSegments = null;
        state.fullSamples = null;
        for(const t of state.targets) if(!t.removed) t.hit = false;
        drawScene();
      }
    }

    requestAnimationFrame(frame);
  });
}

/* ---------- Carica dati mappa nello state ---------- */
/**
 * Applica i dati della mappa allo state del gioco.
 * Resetta tutto: score, tiri, clock, animazione.
 * Deep-copia il motion per evitare shared refs.
 */
function applyMapData(map){
  state.params = {
    canvasWidth: map.canvas?.width || 1000,
    canvasHeight: map.canvas?.height || 560,
    gravity: map.params?.gravity ?? 980,
    restitution: map.params?.restitution ?? 0.8,
    ballRadius: map.params?.ballRadius ?? 10,
    defaultSpeed: map.params?.defaultSpeed ?? 700,
    timeScale: map.params?.timeScale ?? 1,
    samples: map.params?.samples ?? 400,
    shotsTotal: map.params?.shotsTotal ?? 10,
    maxBounces: map.params?.maxBounces ?? 0,
    targets: map.targets ?? []
  };

  canvas.width = state.params.canvasWidth;
  canvas.height = state.params.canvasHeight;
  state.cannon = { x: canvas.width/2, y: 40 };

  // Inizializza target con proprietà di gioco (hit, removed)
  state.targets = state.params.targets.map(t => {
    const base = { ...t, hit:false, removed:false };
    if(!base.shape) base.shape = 'circle';
    if(base.shape === 'rect'){
      base.width = base.width || 40;
      base.height = base.height || 20;
      base.angle = base.angle || 0;
    } else {
      base.r = base.r || 12;
    }
    if(t.motion) base.motion = JSON.parse(JSON.stringify(t.motion));
    return base;
  });

  state.shotsLeft = state.params.shotsTotal;
  state.score = 0;
  state.animating = false;
  state.currentPhysicalTime = 0;
  state.previewSegments = null;
  state.previewSamples = null;
  state.fullSegments = null;
  state.fullSamples = null;
  state.lastMouseAngle = null;
  canvas.style.pointerEvents = 'auto';
  canvas.style.cursor = 'default';

  // Rileva se ci sono target con moto
  state.hasMovingTargets = state.targets.some(t => t.motion && t.motion.segments && t.motion.segments.length > 0);

  // Avvia/riavvia game clock
  state.gameClockStart = performance.now();
  state.gameClock = 0;
  if(!state.gameClockRunning) startGameClock();

  drawScene();
}

/* ---------- Import base64 ---------- */
function setupBase64Import(){
  const input = document.getElementById('base64Input');
  const btn = document.getElementById('loadBase64Btn');

  btn.addEventListener('click', () => {
    const raw = input.value.trim();
    if(!raw){
      updateStatus('Incolla prima un base64 valido');
      return;
    }
    try {
      const json = atob(raw);
      const map = JSON.parse(json);
      applyMapData(map);
      updateStatus('Mappa caricata da base64');
    } catch(err){
      console.error('Errore decodifica base64:', err);
      updateStatus('Base64 non valido o JSON malformato');
    }
  });
}

/* ---------- Init ---------- */
async function init(){
  const map = await loadMap('./map.json');
  if(!map){
    updateStatus('Impossibile caricare la mappa');
    return;
  }

  applyMapData(map);
  attachInputHandlers();
  setupBase64Import();
  updateStatus('Pronto');
}

init();
