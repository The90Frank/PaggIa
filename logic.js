// logic.js
import * as Engine from './engine.js';
import { loadMap } from './mapLoader.js';

const canvas = document.getElementById('gameCanvas');
const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');

let state = {
  params: {},
  targets: [],
  previewSegments: null,
  previewSamples: null,
  fullSegments: null,
  fullSamples: null,
  mousePos: { x: 0, y: 0 },
  animating: false,
  shotsLeft: 0,
  score: 0,
  cannon: { x: 0, y: 40 }
};

/* ---------- Style vars helper ---------- */
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

/* ---------- UI builders ---------- */
function updateStatus(t){ statusEl.textContent = t; }

function buildControls(){
  controlsEl.innerHTML = '';
  const groups = [
    { label: 'Schermo', html: `<label>W</label><input id="canvasW" type="number" value="${state.params.canvasWidth}" min="400" max="1600">
                               <label>H</label><input id="canvasH" type="number" value="${state.params.canvasHeight}" min="300" max="1000">` },
    { label: 'Fisica', html: `<label>Gravità</label><input id="gravity" type="number" value="${state.params.gravity}">
                               <label>Restitution</label><input id="restitution" type="number" step="0.01" value="${state.params.restitution}">` },
    { label: 'Pallina', html: `<label>Raggio</label><input id="ballRadius" type="number" value="${state.params.ballRadius}">
                               <label>Velocità</label><input id="speed" type="number" value="${state.params.defaultSpeed}">` },
    { label: 'Animazione', html: `<label>TimeScale</label><input id="timeScale" type="number" step="0.1" value="${state.params.timeScale}">
                                  <label>Samples</label><input id="samples" type="number" value="${state.params.samples}">
                                  <label>Max Bounces (0 = illimitato)</label><input id="maxBounces" type="number" min="0" value="${state.params.maxBounces || 0}">` },
    { label: 'Azione', html: `<button id="applyBtn">Applica</button> <button id="resetBtn">Reset targets</button>` }
  ];
  for(const g of groups){
    const div = document.createElement('div');
    div.className = 'control-group';
    div.innerHTML = `<div class="small">${g.label}</div><div class="row">${g.html}</div>`;
    controlsEl.appendChild(div);
  }
  document.getElementById('applyBtn').addEventListener('click', applyUI);
  document.getElementById('resetBtn').addEventListener('click', resetTargets);
}

/* ---------- Apply / Reset ---------- */
function applyUI(){
  const w = Number(document.getElementById('canvasW').value);
  const h = Number(document.getElementById('canvasH').value);
  canvas.width = Math.max(400, Math.min(1600, w));
  canvas.height = Math.max(300, Math.min(1000, h));
  state.params.canvasWidth = canvas.width;
  state.params.canvasHeight = canvas.height;

  state.params.gravity = Number(document.getElementById('gravity').value);
  state.params.restitution = Number(document.getElementById('restitution').value);
  state.params.ballRadius = Number(document.getElementById('ballRadius').value);
  state.params.defaultSpeed = Number(document.getElementById('speed').value);
  state.params.timeScale = Number(document.getElementById('timeScale').value);
  state.params.samples = Number(document.getElementById('samples').value);
  state.params.maxBounces = Math.max(0, Math.floor(Number(document.getElementById('maxBounces').value) || 0));

  state.cannon = { x: canvas.width/2, y: 40 };
  state.shotsLeft = state.params.shotsTotal || state.shotsLeft;
  state.previewSegments = null;
  state.previewSamples = null;
  state.fullSegments = null;
  state.fullSamples = null;
  canvas.style.pointerEvents = 'auto';
  canvas.style.cursor = 'default';
  state.animating = false;
  drawScene();
  updateStatus('Parametri applicati');
}

function resetTargets(){
  state.targets = state.params.targets.map(t => ({ ...t, hit:false, removed:false }));
  state.shotsLeft = state.params.shotsTotal || state.shotsLeft;
  state.score = 0;
  state.previewSegments = null;
  state.previewSamples = null;
  state.fullSegments = null;
  state.fullSamples = null;
  canvas.style.pointerEvents = 'auto';
  canvas.style.cursor = 'default';
  state.animating = false;
  drawScene();
  updateStatus('Reset eseguito');
}

/* ---------- Drawing ---------- */
function drawScene(ballX = null, ballY = null, preview = null){
  const ctx = canvas.getContext('2d');
  const style = getGameStyleVars();

  ctx.clearRect(0,0,canvas.width,canvas.height);

  // cannon
  ctx.fillStyle = style.cannon;
  ctx.beginPath(); ctx.arc(state.cannon.x, state.cannon.y, 14,0,Math.PI*2); ctx.fill();

  // tetto e muri
  ctx.strokeStyle = style.wall; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, state.params.ballRadius); ctx.lineTo(canvas.width, state.params.ballRadius);
  ctx.moveTo(state.params.ballRadius, 0); ctx.lineTo(state.params.ballRadius, canvas.height);
  ctx.moveTo(canvas.width - state.params.ballRadius, 0); ctx.lineTo(canvas.width - state.params.ballRadius, canvas.height);
  ctx.stroke();

  // targets: circle o rect (rotated)
  for(const t of state.targets){
    if(t.removed) continue;
    if(t.shape === 'rect'){
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate((t.angle || 0) * Math.PI / 180);
      ctx.fillStyle = t.hit ? style.targetHit : style.target;
      ctx.beginPath();
      ctx.rect(-t.width/2, -t.height/2, t.width, t.height);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = t.hit ? style.targetHit : style.target;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r,0,Math.PI*2); ctx.fill();
    }
  }

  // preview polyline (troncata se fornita) - non disegnare nulla se animating=true
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

  // ball
  if(typeof ballX === 'number'){
    ctx.fillStyle = style.ball;
    ctx.beginPath(); ctx.arc(ballX, ballY, state.params.ballRadius,0,Math.PI*2); ctx.fill();
  }

  // ground
  ctx.strokeStyle = style.ground;
  ctx.beginPath(); ctx.moveTo(0, canvas.height - 20); ctx.lineTo(canvas.width, canvas.height - 20); ctx.stroke();

  // HUD
  ctx.fillStyle = style.hud;
  ctx.font = style.hudFont || '14px Arial';
  ctx.fillText(`Tiri rimasti: ${state.shotsLeft}   Punteggio: ${state.score}`, 12, 18);
}

/* ---------- Helpers per Max Bounces ---------- */
function applyMaxBouncesToSegments(segments){
  const maxB = state.params.maxBounces || 0;
  if(!segments) return segments;
  if(!maxB || maxB <= 0) return segments;
  return Engine.truncateSegmentsByBounces(segments, maxB);
}

/* ---------- Input handlers ---------- */
function attachInputHandlers(){
  // Mouse move: preview troncata (non tocca l'animazione)
  canvas.addEventListener('mousemove', (e)=>{
    if(state.animating) return;

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

    // calcola traiettoria completa, poi troncala per la preview
    const fullSegs = Engine.computeTrajectorySegments(state.cannon.x, state.cannon.y, vx, vy, params);
    const previewSegs = applyMaxBouncesToSegments(fullSegs);

    state.previewSegments = previewSegs;
    state.previewSamples = Engine.sampleTrajectory(previewSegs, state.params.samples, params);

    drawScene(null, null, state.previewSamples);
  });

  // Click: anima usando la traiettoria completa; preview rimane troncata ma viene nascosta durante l'animazione
  canvas.addEventListener('click', (e)=>{
    if(state.animating){ updateStatus('Animazione in corso'); return; }
    if(state.shotsLeft <= 0){ updateStatus('Nessun tiro rimasto'); return; }

    // calcola angolo e traiettorie
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

    // 1) traiettoria completa per animazione
    const fullSegs = Engine.computeTrajectorySegments(state.cannon.x, state.cannon.y, vx, vy, params);
    const fullSamples = Engine.sampleTrajectory(fullSegs, Math.max(state.params.samples, 200), params);

    // 2) preview troncata (rimane memorizzata ma non verrà mostrata durante l'animazione)
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

    const totalPhysicalTime = state.fullSegments[state.fullSegments.length - 1].t1 || 0.0001;
    const animationDuration = Math.max(0.02, totalPhysicalTime * state.params.timeScale);

    for(const t of state.targets) if(!t.removed) t.hit = false;

    state.shotsLeft--; updateStatus('Animazione in corso');

    // disable interactions during animation
    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = 'wait';
    state.animating = true;
    const startWall = performance.now();

    function frame(now){
      const wallElapsed = (now - startWall) / 1000;
      const progress = Math.min(1, wallElapsed / animationDuration);
      const physicalElapsed = progress * totalPhysicalTime;

      // use fullSegments for position (animation continues beyond preview)
      const pos = Engine.getPositionAtPhysicalTime(state.fullSegments, physicalElapsed, state.params.gravity);
      if(!pos){
        state.animating = false;
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        updateStatus('Errore animazione');
        drawScene();
        return;
      }

      // trigger visual hits based on fullSegments timing
      for(const s of state.fullSegments){
        if(s.event === 'target' && s.targetRef && !s.targetRef.removed && !s.targetRef.hit){
          if(physicalElapsed >= s.t1 - 1e-6){
            s.targetRef.hit = true;
            setTimeout((targ)=>{ if(!targ.removed) targ.hit = false; }, 260, s.targetRef);
          }
        }
      }

      // drawScene: during animation we intentionally hide any trajectory (pass null preview)
      drawScene(pos.x, pos.y, null);

      if(progress < 1) requestAnimationFrame(frame);
      else {
        // end animation: remove hit targets and restore interaction
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
        // clear fullSamples but keep preview cleared as well
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

/* ---------- Initialization ---------- */
async function init(){
  const map = await loadMap('./map.json');
  if(!map){
    updateStatus('Impossibile caricare la mappa');
    return;
  }

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
    return base;
  });

  state.shotsLeft = state.params.shotsTotal;
  state.score = 0;

  buildControls();
  document.getElementById('canvasW').value = state.params.canvasWidth;
  document.getElementById('canvasH').value = state.params.canvasHeight;
  document.getElementById('gravity').value = state.params.gravity;
  document.getElementById('restitution').value = state.params.restitution;
  document.getElementById('ballRadius').value = state.params.ballRadius;
  document.getElementById('speed').value = state.params.defaultSpeed;
  document.getElementById('timeScale').value = state.params.timeScale;
  document.getElementById('samples').value = state.params.samples;
  document.getElementById('maxBounces').value = state.params.maxBounces || 0;

  attachInputHandlers();
  drawScene();
  updateStatus('Pronto');
}

init();
