/*
 * game.js — Modalità gioco con personaggi, superpoteri e target mobili.
 *
 * ARCHITETTURA:
 *   Carica la mappa da map.json (default) o da base64 incollato dall'utente.
 *   Il giocatore sceglie un personaggio, poi punta il cannone e spara palline.
 *   Colpire un target speciale (special: true, verde) attiva il superpotere del personaggio.
 *
 * PERSONAGGI E POTERI:
 *   blast     (Stella) — Esplosione area: distrugge tutti i target entro 180px
 *   spooky    (Boo)    — Palla Fantasma: la palla respawna dall'alto dopo essere caduta
 *   multiball (Trio)   — Triball: spawna 2 palle extra con velocità ruotate di ±20°
 *   freeze    (Zen)    — Congelamento: i target mobili si bloccano per il resto del tiro
 *
 * GAME CLOCK:
 *   Un loop requestAnimationFrame continuo mantiene `gameClock` aggiornato.
 *   Serve per animare i target mobili e ricalcolare la preview.
 *
 * TEMPORIZZAZIONE:
 *   - Idle: targetTime = gameClock
 *   - Animazione: targetTime = fireGlobalTime + currentPhysicalTime
 *   - Freeze attivo: targetTime = fireGlobalTime + frozenAtPhysTime (bloccato)
 *
 * DIPENDENZE: engine.js, mapLoader.js, motion.js, characters.js
 * FILE HTML: game.html
 */
import * as Engine from './engine.js';
import { loadMap } from './mapLoader.js';
import { getTargetPositionAtTime } from './motion.js';
import { CHARACTERS } from './characters.js';

const canvas = document.getElementById('gameCanvas');
const statusEl = document.getElementById('status');

/* ---------- Stato del gioco ---------- */
let state = {
  params: {},
  targets: [],
  previewSegments: null,
  previewSamples: null,
  fullSegments: null,
  fullSamples: null,
  mousePos: { x: 0, y: 0 },
  mouseOnCanvas: false,
  lastMouseAngle: null,
  animating: false,
  shotsLeft: 0,
  score: 0,
  cannon: { x: 0, y: 40 },
  // Game clock
  gameClock: 0,
  gameClockStart: 0,
  gameClockRunning: false,
  hasMovingTargets: false,
  // Timing animazione
  fireGlobalTime: 0,
  currentPhysicalTime: 0,
  // Personaggio e potere
  character: null,             // Personaggio selezionato
  _activatedSpecials: new Set(),// Set di target speciali che hanno già attivato il potere in questo tiro
  frozenAtPhysTime: null,      // Tempo fisico in cui è stato attivato il freeze
  extraBalls: [],              // Palle extra per multiball
  blastEffect: null,           // {x, y, startTime} per l'animazione esplosione
  _spookyCharges: 0            // Cariche spooky disponibili (incrementato a ogni hit speciale, decrementato a ogni respawn)
};

/* ---------- CSS custom properties helper ---------- */
function getGameStyleVars(){
  const s = getComputedStyle(document.documentElement);
  const parseLineDash = (str) => {
    const parts = (str || '').trim().split(/\s+/).map(n => Number(n));
    return parts.length ? parts : [6,6];
  };
  return {
    cannon:        s.getPropertyValue('--game-cannon').trim()        || '#999',
    target:        s.getPropertyValue('--game-target').trim()        || '#0af',
    targetHit:     s.getPropertyValue('--game-target-hit').trim()    || '#ff0',
    targetSpecial: s.getPropertyValue('--game-target-special').trim()|| '#2ecc71',
    preview:       s.getPropertyValue('--game-preview').trim()       || 'rgba(255,255,255,0.6)',
    previewMarker: s.getPropertyValue('--game-preview-marker').trim()|| '#ff8',
    ball:          s.getPropertyValue('--game-ball').trim()          || '#f55',
    ballExtra:     s.getPropertyValue('--game-ball-extra').trim()    || '#88aaff',
    ground:        s.getPropertyValue('--game-ground').trim()        || '#444',
    wall:          s.getPropertyValue('--game-wall').trim()          || '#666',
    hud:           s.getPropertyValue('--game-hud').trim()           || '#ddd',
    hudFont:       s.getPropertyValue('--game-hud-font').trim()      || '14px Arial',
    lineDash:      parseLineDash(s.getPropertyValue('--game-line-dash'))
  };
}

/* ---------- Status bar ---------- */
function updateStatus(t){ statusEl.textContent = t; }

/* ---------- Parametri motore (helper riutilizzabile) ---------- */
function makeEngineParams(){
  return {
    gravity:      state.params.gravity,
    restitution:  state.params.restitution,
    ballRadius:   state.params.ballRadius,
    canvasWidth:  state.params.canvasWidth,
    canvasHeight: state.params.canvasHeight,
    targets:      state.targets
  };
}

/* ---------- Tempo target per rendering ---------- */
function getTargetTime(){
  if(state.animating){
    // Freeze: congela al tempo in cui il potere è stato attivato
    const physTime = state.frozenAtPhysTime !== null
      ? state.frozenAtPhysTime
      : state.currentPhysicalTime;
    return state.fireGlobalTime + physTime;
  }
  return state.gameClock;
}

/* ---------- Drawing ---------- */
function drawScene(ballX = null, ballY = null, preview = null){
  const ctx = canvas.getContext('2d');
  const style = getGameStyleVars();
  const targetTime = getTargetTime();

  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Cannone
  ctx.fillStyle = style.cannon;
  ctx.beginPath(); ctx.arc(state.cannon.x, state.cannon.y, 14,0,Math.PI*2); ctx.fill();

  // Soffitto e pareti
  ctx.strokeStyle = style.wall; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, state.params.ballRadius); ctx.lineTo(canvas.width, state.params.ballRadius);
  ctx.moveTo(state.params.ballRadius, 0); ctx.lineTo(state.params.ballRadius, canvas.height);
  ctx.moveTo(canvas.width - state.params.ballRadius, 0); ctx.lineTo(canvas.width - state.params.ballRadius, canvas.height);
  ctx.stroke();

  // Target
  for(const t of state.targets){
    if(t.removed) continue;
    const pos = getTargetPositionAtTime(t, targetTime);
    const isSpecial = !!t.special;
    const fillColor = t.hit ? style.targetHit : (isSpecial ? style.targetSpecial : style.target);

    ctx.save();
    // Glow verde per target speciali non ancora colpiti
    if(isSpecial && !t.hit){
      ctx.shadowColor = style.targetSpecial;
      ctx.shadowBlur = 18;
    }
    if(t.shape === 'rect'){
      ctx.translate(pos.x, pos.y);
      ctx.rotate((t.angle || 0) * Math.PI / 180);
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.rect(-t.width/2, -t.height/2, t.width, t.height);
      ctx.fill();
    } else {
      ctx.fillStyle = fillColor;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, t.r,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  // Preview traiettoria (solo in idle)
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

  // Effetto esplosione (cerchio che si espande e sfuma)
  if(state.blastEffect){
    const elapsed = (performance.now() - state.blastEffect.startTime) / 1000;
    if(elapsed < 0.5){
      const prog = elapsed / 0.5;
      const radius = 180 * prog;
      const alpha = 1 - prog;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 120, 0, ${alpha})`;
      ctx.lineWidth = Math.max(1, 5 * (1 - prog * 0.6));
      ctx.beginPath();
      ctx.arc(state.blastEffect.x, state.blastEffect.y, radius, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    } else {
      state.blastEffect = null;
    }
  }

  // Palla principale
  if(typeof ballX === 'number'){
    ctx.fillStyle = style.ball;
    ctx.beginPath(); ctx.arc(ballX, ballY, state.params.ballRadius,0,Math.PI*2); ctx.fill();
  }

  // Palle extra (multiball)
  for(const eb of state.extraBalls){
    if(eb.done || !eb.currentPos) continue;
    ctx.save();
    ctx.fillStyle = style.ballExtra;
    ctx.shadowColor = style.ballExtra;
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(eb.currentPos.x, eb.currentPos.y, state.params.ballRadius,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Ground
  ctx.strokeStyle = style.ground;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, canvas.height - 20); ctx.lineTo(canvas.width, canvas.height - 20); ctx.stroke();

  // HUD — tiri e punteggio
  ctx.fillStyle = style.hud;
  ctx.font = style.hudFont || '14px Arial';
  ctx.fillText(`Tiri rimasti: ${state.shotsLeft}   Punteggio: ${state.score}`, 12, 18);

  // HUD — personaggio e stato potere (con conteggio attivazioni)
  if(state.character){
    const count = state._activatedSpecials?.size || 0;
    const powerLabel = count > 0
      ? `ATTIVATO ×${count}`
      : (state.animating ? '...' : 'pronto');
    ctx.fillStyle = count > 0 ? '#ffaa00' : (style.hud || '#ddd');
    ctx.fillText(
      `${state.character.emoji} ${state.character.name} — ${state.character.power}: ${powerLabel}`,
      12, 36
    );
  }
}

/* ---------- Max Bounces ---------- */
function applyMaxBouncesToSegments(segments){
  const maxB = state.params.maxBounces || 0;
  if(!segments) return segments;
  if(!maxB || maxB <= 0) return segments;
  return Engine.truncateSegmentsByBounces(segments, maxB);
}

/* ---------- Preview traiettoria ---------- */
function recomputePreview(){
  if(state.animating || state.lastMouseAngle === null) return;
  const speed = state.params.defaultSpeed;
  const ang = state.lastMouseAngle;
  const vx = speed * Math.cos(ang);
  const vy = speed * Math.sin(ang);
  const params = makeEngineParams();
  const fullSegs = Engine.computeTrajectorySegments(state.cannon.x, state.cannon.y, vx, vy, params, state.gameClock);
  const previewSegs = applyMaxBouncesToSegments(fullSegs);
  state.previewSegments = previewSegs;
  state.previewSamples = Engine.sampleTrajectory(previewSegs, state.params.samples, params);
}

/* ---------- Game clock ---------- */
function startGameClock(){
  state.gameClockStart = performance.now();
  state.gameClockRunning = true;

  function tick(now){
    if(!state.gameClockRunning) return;
    state.gameClock = (now - state.gameClockStart) / 1000;

    if(!state.animating && state.hasMovingTargets){
      if(state.mouseOnCanvas) recomputePreview();
      drawScene(null, null, state.previewSamples);
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- Attivazione potere ---------- */
/**
 * Chiamata quando la palla colpisce un target speciale durante l'animazione.
 * @param {object} hitSegment  - Segmento traiettoria in cui è avvenuta la collisione
 * @param {number} physElapsed - Tempo fisico corrente nell'animazione
 * @param {number} wallElapsed - Tempo wall-clock dall'inizio dell'animazione (secondi)
 */
function activatePower(hitSegment, physElapsed, wallElapsed){
  const char = state.character;
  if(!char) return;

  const hitTarget = hitSegment.targetRef;
  const globalAtHit = state.fireGlobalTime + hitSegment.t1;
  const hitPos = getTargetPositionAtTime(hitTarget, globalAtHit);

  switch(char.type){
    case 'blast': {
      // Distrugge tutti i target entro BLAST_RADIUS px dal punto di impatto.
      // scored=true marca per il punteggio finale (permanente fino a finishAnimation).
      // hit=true è solo il flash visivo giallo (cancellato da setTimeout).
      const BLAST_RADIUS = 180;
      for(const t of state.targets){
        if(t.removed) continue;
        const tpos = getTargetPositionAtTime(t, globalAtHit);
        if(Math.hypot(tpos.x - hitPos.x, tpos.y - hitPos.y) <= BLAST_RADIUS){
          t.scored = true;
          t.hit = true;
          setTimeout(targ => { if(!targ.removed) targ.hit = false; }, 500, t);
        }
      }
      state.blastEffect = { x: hitPos.x, y: hitPos.y, startTime: performance.now() };
      break;
    }

    case 'spooky': {
      // Aggiunge una carica spooky: ogni carica = un respawn dall'alto dopo che la palla cade
      state._spookyCharges++;
      break;
    }

    case 'multiball': {
      // Spawna 2 palle extra con velocità ruotate di ±20° rispetto all'impatto
      const dt = hitSegment.t1 - hitSegment.t0;
      const impactVx = hitSegment.vx;
      const impactVy = hitSegment.vy + state.params.gravity * dt;
      const speed = Math.hypot(impactVx, impactVy);
      const baseAngle = Math.atan2(impactVy, impactVx);
      const params = makeEngineParams();

      for(const angleDiff of [-Math.PI / 9, Math.PI / 9]){
        const newVx = speed * Math.cos(baseAngle + angleDiff);
        const newVy = speed * Math.sin(baseAngle + angleDiff);
        const segs = Engine.computeTrajectorySegments(
          hitPos.x, hitPos.y, newVx, newVy, params, globalAtHit
        );
        if(!segs || segs.length === 0) continue;
        const physTotal = segs[segs.length - 1].t1 || 0.001;
        const wallDur = Math.max(0.02, physTotal * state.params.timeScale);
        state.extraBalls.push({
          segments: segs,
          wallOffset: wallElapsed, // parte subito
          physTotal,
          wallDur,
          currentPos: null,
          done: false
        });
      }
      break;
    }

    case 'freeze': {
      // Congela i target mobili: salva il tempo fisico corrente
      state.frozenAtPhysTime = physElapsed;
      break;
    }
  }
}

/* ---------- Character UI ---------- */
function setupCharacterUI(){
  const panel = document.getElementById('characterButtons');
  if(!panel) return;

  for(const char of CHARACTERS){
    const btn = document.createElement('button');
    btn.className = 'char-btn';
    btn.dataset.charId = char.id;
    btn.style.setProperty('--char-color', char.color);
    btn.innerHTML =
      `<span class="char-emoji">${char.emoji}</span>` +
      `<span class="char-name">${char.name}</span>` +
      `<span class="char-power-name">${char.power}</span>`;
    btn.addEventListener('click', () => {
      if(state.animating) return;
      state.character = char;
      panel.querySelectorAll('.char-btn').forEach(b => b.classList.toggle('active', b === btn));
      const desc = document.getElementById('characterDesc');
      if(desc) desc.textContent = char.desc;
    });
    panel.appendChild(btn);
  }
  // Seleziona il primo personaggio di default
  panel.querySelector('.char-btn')?.click();
}

/* ---------- Input handlers ---------- */
function attachInputHandlers(){
  canvas.addEventListener('mouseenter', () => { state.mouseOnCanvas = true; });
  canvas.addEventListener('mouseleave', () => { state.mouseOnCanvas = false; });

  canvas.addEventListener('mousemove', (e)=>{
    if(state.animating) return;
    const rect = canvas.getBoundingClientRect();
    state.mousePos.x = e.clientX - rect.left;
    state.mousePos.y = e.clientY - rect.top;
    state.lastMouseAngle = Math.atan2(state.mousePos.y - state.cannon.y, state.mousePos.x - state.cannon.x);
    recomputePreview();
    if(!state.hasMovingTargets){
      drawScene(null, null, state.previewSamples);
    }
  });

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
    const params = makeEngineParams();

    state.fireGlobalTime = state.gameClock;

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

    const totalPhysicalTime = state.fullSegments[state.fullSegments.length - 1].t1 || 0.0001;
    const animationDuration = Math.max(0.02, totalPhysicalTime * state.params.timeScale);

    for(const t of state.targets) if(!t.removed){ t.hit = false; t.scored = false; }

    // Reset stato per questo tiro
    state._activatedSpecials = new Set();
    state.frozenAtPhysTime = null;
    state.extraBalls = [];
    state.blastEffect = null;
    state._spookyCharges = 0;
    state._lastSpookyVx = undefined;

    state.shotsLeft--;
    updateStatus('Animazione in corso');
    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = 'wait';
    state.animating = true;
    state.currentPhysicalTime = 0;
    const startWall = performance.now();

    /* --- Fine animazione: segna target, aggiorna score, torna a idle --- */
    function finishAnimation(){
      // Scoring: tutti i target con scored=true (marker permanente) vengono rimossi
      for(const t of state.targets){
        if(t.scored && !t.removed){
          state.score += 100;
          t.removed = true;
        }
      }
      canvas.style.pointerEvents = 'auto';
      canvas.style.cursor = 'default';
      state.animating = false;
      state.currentPhysicalTime = 0;
      state.frozenAtPhysTime = null;
      state.extraBalls = [];
      state.blastEffect = null;
      state.previewSegments = null;
      state.previewSamples = null;
      state.fullSegments = null;
      state.fullSamples = null;
      for(const t of state.targets) if(!t.removed){ t.hit = false; t.scored = false; }

      const remaining = state.targets.filter(t => !t.removed).length;
      if(remaining === 0)       updateStatus(`Livello completato! Punteggio: ${state.score}`);
      else if(state.shotsLeft <= 0) updateStatus(`Game Over! Punteggio: ${state.score}`);
      else                      updateStatus('Pronto');
      drawScene();
    }

    /* --- Spooky Ball: traiettoria dall'alto dopo che la palla cade.
           Può essere concatenata: alla fine, se ci sono ancora cariche, lancia un altro respawn.
           Pre-condizione: state.fireGlobalTime già aggiornato al tempo di partenza del nuovo respawn. --- */
    function launchSpookyBall(lastPos){
      // Velocità di rispawn: usa la velocità orizzontale dell'ultimo "lastPos" disponibile
      // (per il primo respawn viene dalla traiettoria principale; per i successivi dalla spooky precedente)
      // Spawna la palla in cima allo schermo, stesso X di dove è caduta
      const spawnX = Math.max(
        state.params.ballRadius + 1,
        Math.min(state.params.canvasWidth - state.params.ballRadius - 1, lastPos.x)
      );
      const spawnY = state.params.ballRadius + 2;

      // Velocità di spawn: piccola componente verticale verso il basso, X variabile
      // Per il primo respawn usa la velocità della palla principale; altrimenti default
      const spawnVx = (state._lastSpookyVx !== undefined) ? state._lastSpookyVx : (state.params.defaultSpeed * 0.4);
      const spawnVy = 200;

      const spookyParams = makeEngineParams();
      const spookySegs = Engine.computeTrajectorySegments(spawnX, spawnY, spawnVx, spawnVy, spookyParams, state.fireGlobalTime);
      if(!spookySegs || spookySegs.length === 0){ finishAnimation(); return; }

      const spookyPhysTotal = spookySegs[spookySegs.length - 1].t1 || 0.001;
      const spookyAnimDur = Math.max(0.02, spookyPhysTotal * state.params.timeScale);
      const spookyStart = performance.now();

      function spookyFrame(now){
        const wallEl = (now - spookyStart) / 1000;
        const prog = Math.min(1, wallEl / spookyAnimDur);
        const physEl = prog * spookyPhysTotal;
        state.currentPhysicalTime = physEl;

        const sPos = Engine.getPositionAtPhysicalTime(spookySegs, physEl, state.params.gravity);

        // Marca i target colpiti dalla spooky ball (scored permanente, hit visivo)
        for(const s of spookySegs){
          if(s.event === 'target' && s.targetRef && !s.targetRef.removed && !s.targetRef.scored){
            if(physEl >= s.t1 - 1e-6){
              s.targetRef.scored = true;
              s.targetRef.hit = true;
              setTimeout(targ => { if(!targ.removed) targ.hit = false; }, 260, s.targetRef);
            }
          }
        }

        drawScene(sPos?.x, sPos?.y, null);

        if(prog < 1){
          requestAnimationFrame(spookyFrame);
        } else {
          // Se ci sono ancora cariche spooky, concatena un altro respawn
          if(state._spookyCharges > 0){
            state._spookyCharges--;
            // Avanza fireGlobalTime per l'offset cumulativo dei target mobili
            state.fireGlobalTime += spookyPhysTotal;
            launchSpookyBall(sPos || lastPos);
          } else {
            finishAnimation();
          }
        }
      }
      requestAnimationFrame(spookyFrame);
    }

    /* --- Loop animazione principale --- */
    function frame(now){
      const wallElapsed = (now - startWall) / 1000;
      const mainProgress = Math.min(1, wallElapsed / animationDuration);
      const physicalElapsed = mainProgress * totalPhysicalTime;
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

      // Controlla collisione con target speciali → attiva potere (una volta per ogni target speciale)
      // Usa Set per tracciare quali speciali hanno già attivato → permette attivazioni multiple in un tiro
      if(state.character){
        for(const s of state.fullSegments){
          if(s.event === 'target' && s.targetRef?.special && !s.targetRef.removed && !state._activatedSpecials.has(s.targetRef)){
            if(physicalElapsed >= s.t1 - 1e-6){
              state._activatedSpecials.add(s.targetRef);
              activatePower(s, physicalElapsed, wallElapsed);
            }
          }
        }
      }

      // Marca target colpiti: scored=true (per scoring finale) + hit=true (per flash visivo)
      for(const s of state.fullSegments){
        if(s.event === 'target' && s.targetRef && !s.targetRef.removed && !s.targetRef.scored){
          if(physicalElapsed >= s.t1 - 1e-6){
            s.targetRef.scored = true;
            s.targetRef.hit = true;
            setTimeout(targ => { if(!targ.removed) targ.hit = false; }, 260, s.targetRef);
          }
        }
      }

      // Aggiorna palle extra (multiball)
      for(const eb of state.extraBalls){
        if(eb.done) continue;
        const ebWall = wallElapsed - eb.wallOffset;
        if(ebWall < 0) continue;
        const ebProgress = Math.min(1, ebWall / eb.wallDur);
        const ebPhys = ebProgress * eb.physTotal;
        eb.currentPos = Engine.getPositionAtPhysicalTime(eb.segments, ebPhys, state.params.gravity);
        // Marca target colpiti dalle palle extra (scored permanente, hit visivo)
        for(const s of eb.segments){
          if(s.event === 'target' && s.targetRef && !s.targetRef.removed && !s.targetRef.scored){
            if(ebPhys >= s.t1 - 1e-6){
              s.targetRef.scored = true;
              s.targetRef.hit = true;
              setTimeout(targ => { if(!targ.removed) targ.hit = false; }, 260, s.targetRef);
            }
          }
        }
        if(ebProgress >= 1) eb.done = true;
      }

      drawScene(pos.x, pos.y, null);

      const mainDone = mainProgress >= 1;
      const extraAllDone = state.extraBalls.every(eb => eb.done);

      if(mainDone && extraAllDone){
        // Spooky ball: consuma una carica e respawna dall'alto
        if(state._spookyCharges > 0){
          state._spookyCharges--;
          // Per il primo respawn: salva la velocità orizzontale al ground impact
          let lastFlight = null;
          for(let i = state.fullSegments.length - 1; i >= 0; i--){
            const s = state.fullSegments[i];
            if(!s.ground && s.t1 > s.t0){ lastFlight = s; break; }
          }
          state._lastSpookyVx = lastFlight ? lastFlight.vx : (state.params.defaultSpeed * 0.4);
          // Avanza fireGlobalTime al termine della traiettoria principale
          state.fireGlobalTime += totalPhysicalTime;
          launchSpookyBall(pos);
          return;
        }
        finishAnimation();
      } else {
        requestAnimationFrame(frame);
      }
    }

    requestAnimationFrame(frame);
  });
}

/* ---------- Carica dati mappa nello state ---------- */
function applyMapData(map){
  state.params = {
    canvasWidth:  map.canvas?.width       || 1000,
    canvasHeight: map.canvas?.height      || 560,
    gravity:      map.params?.gravity     ?? 980,
    restitution:  map.params?.restitution ?? 0.8,
    ballRadius:   map.params?.ballRadius  ?? 10,
    defaultSpeed: map.params?.defaultSpeed?? 700,
    timeScale:    map.params?.timeScale   ?? 1,
    samples:      map.params?.samples     ?? 400,
    shotsTotal:   map.params?.shotsTotal  ?? 10,
    maxBounces:   map.params?.maxBounces  ?? 0,
    targets:      map.targets             ?? []
  };

  canvas.width  = state.params.canvasWidth;
  canvas.height = state.params.canvasHeight;
  state.cannon  = { x: canvas.width/2, y: 40 };

  state.targets = state.params.targets.map(t => {
    const base = { ...t, hit: false, scored: false, removed: false };
    if(!base.shape) base.shape = 'circle';
    if(base.shape === 'rect'){
      base.width  = base.width  || 40;
      base.height = base.height || 20;
      base.angle  = base.angle  || 0;
    } else {
      base.r = base.r || 12;
    }
    if(t.motion) base.motion = JSON.parse(JSON.stringify(t.motion));
    return base;
  });

  state.shotsLeft        = state.params.shotsTotal;
  state.score            = 0;
  state.animating        = false;
  state.currentPhysicalTime = 0;
  state.frozenAtPhysTime = null;
  state.extraBalls       = [];
  state.blastEffect      = null;
  state._activatedSpecials = new Set();
  state._spookyCharges   = 0;
  state._lastSpookyVx    = undefined;
  state.previewSegments  = null;
  state.previewSamples   = null;
  state.fullSegments     = null;
  state.fullSamples      = null;
  state.lastMouseAngle   = null;
  canvas.style.pointerEvents = 'auto';
  canvas.style.cursor = 'default';

  state.hasMovingTargets = state.targets.some(t => t.motion && t.motion.segments && t.motion.segments.length > 0);

  state.gameClockStart = performance.now();
  state.gameClock = 0;
  if(!state.gameClockRunning) startGameClock();

  drawScene();
}

/* ---------- Import base64 ---------- */
function setupBase64Import(){
  const input = document.getElementById('base64Input');
  const btn   = document.getElementById('loadBase64Btn');

  btn.addEventListener('click', () => {
    const raw = input.value.trim();
    if(!raw){
      updateStatus('Incolla prima un base64 valido');
      return;
    }
    try {
      const json = atob(raw);
      const map  = JSON.parse(json);
      applyMapData(map);
      updateStatus('Mappa caricata da base64');
    } catch(err){
      console.error('Errore decodifica base64:', err);
      updateStatus('Base64 non valido o JSON malformato');
    }
  });
}

/* ---------- Selettore livelli classici ---------- */
/**
 * Popola la <select> con i livelli da default_levels/index.json.
 * Al click su "Carica" fetcha il JSON del livello e chiama applyMapData.
 */
async function setupLevelSelector(){
  const select = document.getElementById('levelSelect');
  const btn    = document.getElementById('loadLevelBtn');
  if(!select || !btn) return;

  // Carica l'indice dei livelli disponibili
  try {
    const idx = await loadMap('./default_levels/index.json');
    if(idx && Array.isArray(idx.levels)){
      for(const lvl of idx.levels){
        const opt = document.createElement('option');
        opt.value = lvl.file;
        opt.textContent = lvl.name;
        opt.title = lvl.desc || '';
        select.appendChild(opt);
      }
    }
  } catch(err){
    console.error('Errore caricamento indice livelli:', err);
  }

  btn.addEventListener('click', async () => {
    const file = select.value;
    if(!file){ updateStatus('Seleziona prima un livello'); return; }
    const map = await loadMap('./default_levels/' + file);
    if(!map){ updateStatus('Impossibile caricare il livello'); return; }
    applyMapData(map);
    const name = select.options[select.selectedIndex]?.textContent || file;
    updateStatus(`Livello caricato: ${name}`);
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
  setupCharacterUI();
  setupLevelSelector();
  updateStatus('Pronto');
}

init();
