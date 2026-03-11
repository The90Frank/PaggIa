/*
 * engine.js — Motore fisico per traiettorie della pallina con rimbalzi.
 *
 * ARCHITETTURA:
 *   La pallina parte dal cannone con velocità (vx,vy) e si muove sotto gravità.
 *   Il motore trova gli eventi (collisioni) uno alla volta tramite campionamento+bisezione,
 *   costruendo una catena di segmenti parabolici.
 *
 * COLLISION DETECTION:
 *   Per ogni tipo di collisione si definisce f(dt) = distanza² - raggio²:
 *   - Ground/ceiling/walls: equazione quadratica risolta analiticamente
 *   - Target cerchio: f(dt) = |ball(dt) - target(dt)|² - (r_target + r_ball)²
 *   - Target rettangolo: f(dt) = |ball(dt) - closestPointOnRect(dt)|² - r_ball²
 *   Il campionamento (120-200 step su 5s) trova i cambi di segno,
 *   poi 48 iterazioni di bisezione trovano dt con precisione ~1e-8.
 *
 * TRASFERIMENTO DI ENERGIA (target mobili):
 *   La collisione usa la velocità relativa: v_rel = v_ball - v_target.
 *   La riflessione avviene nel frame del target, poi si ritrasforma nel frame mondo.
 *   Effetto: target che si muove verso la palla → rimbalzo più forte.
 *
 * FUNZIONI ESPORTATE:
 *   solveQuadratic(a,b,c)                    → soluzioni positive di ax²+bx+c=0
 *   reflectVelocity(vx,vy,nx,ny,restitution) → velocità riflessa
 *   findNextEvent(...)                        → prossimo evento (ground/ceiling/wall/target)
 *   computeTrajectorySegments(...)            → catena completa di segmenti parabolici
 *   truncateSegmentsByBounces(segs, max)      → tronca dopo N rimbalzi (per preview)
 *   sampleTrajectory(segs, samples, params)   → campiona punti per disegno polyline
 *   getPositionAtPhysicalTime(segs, t, g)     → posizione esatta al tempo t (per animazione)
 *
 * DIPENDENZE: motion.js (getTargetPositionAtTime, getTargetVelocityAtTime)
 * USATO DA: game.js (preview + animazione tiro)
 */
import { getTargetPositionAtTime, getTargetVelocityAtTime } from './motion.js';

export const EPS = 1e-9;

/**
 * Risolve ax² + bx + c = 0, ritorna solo soluzioni t ≥ 0 ordinate.
 * Usata per ground/ceiling (parabola vs linea orizzontale).
 */
export function solveQuadratic(a,b,c, eps=EPS){
  const sol = [];
  if(Math.abs(a) < eps){
    if(Math.abs(b) < eps) return sol;
    const t = -c/b;
    if(t >= 0) sol.push(t);
    return sol;
  }
  const D = b*b - 4*a*c;
  if(D < 0) return sol;
  const sd = Math.sqrt(D);
  const t1 = (-b - sd) / (2*a);
  const t2 = (-b + sd) / (2*a);
  if(t1 >= 0) sol.push(t1);
  if(t2 >= 0) sol.push(t2);
  return sol.sort((x,y)=>x-y);
}

/**
 * Riflette una velocità rispetto a una normale con coefficiente di restituzione.
 * v_reflected = (v - 2*(v·n)*n) * restitution
 */
export function reflectVelocity(vx, vy, nx, ny, restitution){
  const vDotN = vx*nx + vy*ny;
  let rx = vx - 2*vDotN*nx;
  let ry = vy - 2*vDotN*ny;
  rx *= restitution; ry *= restitution;
  return { vx: rx, vy: ry };
}

/* --- Helpers per rettangoli ruotati --- */

/** Trasforma un punto dal mondo allo spazio locale del rettangolo (ruotato). */
function worldToRectLocal(px, py, rect){
  const cx = rect.x, cy = rect.y;
  const a = -rect.angleRad; // angolo inverso per trasformazione inversa
  const dx = px - cx, dy = py - cy;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  return {
    x: dx * cosA - dy * sinA,
    y: dx * sinA + dy * cosA
  };
}

/** Trova il punto più vicino su un rettangolo ruotato a un punto dato. */
function closestPointOnRotatedRect(px, py, rect){
  // Trasforma in locale, clamp all'AABB, ritrasforma in mondo
  const local = worldToRectLocal(px, py, rect);
  const hx = rect.width / 2, hy = rect.height / 2;
  const cx = Math.max(-hx, Math.min(hx, local.x));
  const cy = Math.max(-hy, Math.min(hy, local.y));
  const a = rect.angleRad;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const wx = rect.x + cx * cosA - cy * sinA;
  const wy = rect.y + cx * sinA + cy * cosA;
  return { x: wx, y: wy };
}

/**
 * Trova il prossimo evento (collisione) dalla posizione/velocità corrente.
 *
 * @param {number} px,py       - Posizione iniziale della palla
 * @param {number} vx,vy       - Velocità iniziale della palla
 * @param {number} t0           - Tempo fisico assoluto (per i segmenti della traiettoria)
 * @param {Array} snapshotTargets - Snapshot dei target (con .ref al target originale)
 * @param {object} params       - {gravity, ballRadius, canvasWidth, canvasHeight}
 * @param {number} globalTimeAtT0 - Tempo globale del gioco al momento t0 (per target mobili)
 * @returns {{t, type, dt, target?, wallX?} | null}
 */
export function findNextEvent(px,py,vx,vy,t0, snapshotTargets, params, globalTimeAtT0){
  const { gravity, ballRadius, canvasWidth, canvasHeight } = params;
  const gTime = globalTimeAtT0 || 0;
  let best = null;

  // --- Ground: y = canvasHeight - 20 ---
  {
    // Equazione: py + vy*dt + 0.5*g*dt² = canvasHeight - 20
    const a = 0.5 * gravity;
    const b = vy;
    const c = py - (canvasHeight - 20);
    const sols = solveQuadratic(a,b,c);
    for(const dt of sols){
      if(dt <= 1e-6) continue;
      const tAbs = t0 + dt;
      if(!best || tAbs < best.t) best = { t: tAbs, type: 'ground', dt, target: null };
    }
  }

  // --- Ceiling: y = ballRadius ---
  {
    const ceilingY = ballRadius;
    const a = 0.5 * gravity;
    const b = vy;
    const c = py - ceilingY;
    const sols = solveQuadratic(a,b,c);
    for(const dt of sols){
      if(dt <= 1e-6) continue;
      const tAbs = t0 + dt;
      if(!best || tAbs < best.t) best = { t: tAbs, type: 'ceiling', dt, target: null };
    }
  }

  // --- Walls: x = ballRadius (sinistra) e x = canvasWidth - ballRadius (destra) ---
  // Moto orizzontale è lineare (no gravità su x): x(dt) = px + vx*dt
  if(Math.abs(vx) > 1e-9){
    const wallLeftX = ballRadius;
    const dtLeft = (wallLeftX - px) / vx;
    if(dtLeft > 1e-6){
      const tAbs = t0 + dtLeft;
      if(!best || tAbs < best.t) best = { t: tAbs, type: 'wall', dt: dtLeft, wallX: wallLeftX };
    }
    const wallRightX = canvasWidth - ballRadius;
    const dtRight = (wallRightX - px) / vx;
    if(dtRight > 1e-6){
      const tAbs = t0 + dtRight;
      if(!best || tAbs < best.t) best = { t: tAbs, type: 'wall', dt: dtRight, wallX: wallRightX };
    }
  }

  // --- Targets: campionamento + bisezione ---
  // Per target mobili, la posizione dipende da globalTime + dt → campionamento necessario.
  // Target statici: 120 step; Target mobili: 200 step (più preciso).
  for(const tgt of snapshotTargets){
    if(tgt.removed) continue;

    const hasMotion = !!(tgt.ref && tgt.ref.motion);
    const steps = hasMotion ? 200 : 120;
    const Tmax = 5.0; // finestra temporale di ricerca (secondi)

    if(tgt.shape === 'rect'){
      // f(dt) = dist²(ball, closestPointOnRect) - ballRadius²
      const f = (dt) => {
        const bx = px + vx*dt;
        const by = py + vy*dt + 0.5*gravity*dt*dt;
        const tgtPos = hasMotion ? getTargetPositionAtTime(tgt.ref, gTime + dt) : tgt;
        const rect = { x: tgtPos.x, y: tgtPos.y, width: tgt.width, height: tgt.height, angleRad: (tgt.angleRad ?? 0) };
        const closest = closestPointOnRotatedRect(bx, by, rect);
        const dx = bx - closest.x, dy = by - closest.y;
        return dx*dx + dy*dy - (ballRadius * ballRadius);
      };
      // Campionamento: cerca il primo cambio di segno di f(dt)
      let tPrev = 1e-6, fPrev = f(tPrev);
      for(let k=1;k<=steps;k++){
        const tCurr = (Tmax * k)/steps;
        const fCurr = f(tCurr);
        if(fPrev * fCurr <= 0){
          // Bisezione: 48 iterazioni → precisione ~1e-14
          let a = tPrev, b = tCurr, fa = fPrev, fb = fCurr;
          for(let it=0; it<48; it++){
            const m = 0.5*(a+b), fm = f(m);
            if(Math.abs(fm) < 1e-8) { a = b = m; break; }
            if(fa * fm <= 0){ b = m; fb = fm; } else { a = m; fa = fm; }
          }
          const dt = 0.5*(a+b);
          if(dt > 1e-6){
            const tAbs = t0 + dt;
            if(!best || tAbs < best.t) best = { t: tAbs, type: 'target', dt, target: tgt };
          }
          break; // Primo evento trovato per questo target
        }
        tPrev = tCurr; fPrev = fCurr;
      }
    } else {
      // Cerchio: f(dt) = |ball - target|² - (r_target + r_ball)²
      const rsum = (tgt.r || 0) + ballRadius;
      const f = (dt) => {
        const bx = px + vx*dt;
        const by = py + vy*dt + 0.5*gravity*dt*dt;
        const tgtPos = hasMotion ? getTargetPositionAtTime(tgt.ref, gTime + dt) : tgt;
        const dx = bx - tgtPos.x, dy = by - tgtPos.y;
        return dx*dx + dy*dy - rsum*rsum;
      };
      let tPrev = 1e-6, fPrev = f(tPrev);
      for(let k=1;k<=steps;k++){
        const tCurr = (Tmax * k)/steps;
        const fCurr = f(tCurr);
        if(fPrev * fCurr <= 0){
          let a = tPrev, b = tCurr, fa = fPrev, fb = fCurr;
          for(let it=0; it<48; it++){
            const m = 0.5*(a+b), fm = f(m);
            if(Math.abs(fm) < 1e-8) { a = b = m; break; }
            if(fa * fm <= 0){ b = m; fb = fm; } else { a = m; fa = fm; }
          }
          const dt = 0.5*(a+b);
          if(dt > 1e-6){
            const tAbs = t0 + dt;
            if(!best || tAbs < best.t) best = { t: tAbs, type: 'target', dt, target: tgt };
          }
          break;
        }
        tPrev = tCurr; fPrev = fCurr;
      }
    }
  }

  return best;
}

/**
 * Costruisce la catena completa di segmenti parabolici della traiettoria.
 *
 * Ogni segmento è: { t0, t1, px, py, vx, vy, event, targetRef, wallX? }
 * dove la posizione al tempo t (con t0 ≤ t ≤ t1) è:
 *   x(t) = px + vx*(t-t0)
 *   y(t) = py + vy*(t-t0) + 0.5*gravity*(t-t0)²
 *
 * Il ciclo trova eventi fino a ground (pallina fermata) o max 120 eventi.
 *
 * TRASFERIMENTO DI ENERGIA:
 *   Alla collisione con target mobile, la riflessione avviene nel frame del target:
 *   1. v_rel = v_ball - v_target  (velocità relativa)
 *   2. Riflessione: v_rel_reflected = v_rel - 2*(v_rel·n)*n
 *   3. Restituzione: v_rel_reflected *= restitution
 *   4. Ritorno al frame mondo: v_final = v_rel_reflected + v_target
 *
 * @param {number} initX,initY   - Posizione iniziale (cannone)
 * @param {number} initVx,initVy - Velocità iniziale
 * @param {object} params         - Parametri fisici + targets
 * @param {number} globalStartTime - Tempo globale del gioco al momento del tiro
 * @returns {Array} Catena di segmenti parabolici
 */
export function computeTrajectorySegments(initX, initY, initVx, initVy, params, globalStartTime){
  const { gravity, restitution, ballRadius, canvasWidth, canvasHeight } = params;
  const gStart = globalStartTime || 0;
  const segments = [];
  let px = initX, py = initY, vx = initVx, vy = initVy;
  let t0 = 0;
  const maxEvents = 120;

  // Snapshot dei target: copia valori statici, mantiene .ref al target originale
  // (per accedere a motion e per marcare hit nel gioco)
  const snapshot = params.targets.map(t => ({
    x: t.x, y: t.y, r: t.r, removed: t.removed, ref: t,
    shape: t.shape || 'circle',
    width: t.width, height: t.height,
    angle: t.angle || 0,
    angleRad: ((t.angle || 0) * Math.PI / 180)
  }));

  // Anti-loop: evita collisioni ripetute con lo stesso target in tempi ravvicinati
  let lastHitTarget = null;
  let lastHitTime = -1;

  for(let ev=0; ev<maxEvents; ev++){
    const globalTimeAtT0 = gStart + t0;
    const evn = findNextEvent(px,py,vx,vy,t0, snapshot, params, globalTimeAtT0);
    if(!evn) break;
    const dt = evn.dt;
    const t1 = t0 + dt;
    const targetRef = evn.target ? evn.target.ref : null;
    segments.push({ t0, t1, px, py, vx, vy, event: evn.type, targetRef, wallX: evn.wallX });

    // Posizione della palla al momento dell'evento
    const ex = px + vx*dt;
    const ey = py + vy*dt + 0.5*gravity*dt*dt;

    if(evn.type === 'ground'){
      // Pallina a terra — fine traiettoria
      segments.push({ t0: t1, t1: t1, px: ex, py: ey, vx: 0, vy: 0, ground:true });
      break;
    } else if(evn.type === 'ceiling'){
      // Rimbalzo soffitto: inverti vy, mantieni vx
      const vix = vx;
      const viy = vy + gravity*dt; // velocità al momento dell'impatto
      const newVy = -viy * restitution;
      const newVx = vix;
      const push = 0.6; // sposta la palla leggermente lontano dal soffitto
      px = ex;
      py = ballRadius + push;
      vx = newVx;
      vy = newVy;
      t0 = t1;
      lastHitTarget = null;
      lastHitTime = -1;
      continue;
    } else if(evn.type === 'wall'){
      // Rimbalzo parete: inverti vx, mantieni vy
      const nx = (evn.wallX === ballRadius) ? 1 : -1; // normale verso l'interno
      const vix = vx;
      const viy = vy + gravity*dt;
      const newVx = -vix * restitution;
      const newVy = viy;
      const push = 0.6;
      px = evn.wallX + nx * push;
      py = ey;
      vx = newVx;
      vy = newVy;
      t0 = t1;
      lastHitTarget = null;
      lastHitTime = -1;
      continue;
    } else if(evn.type === 'target'){
      const tgtSnap = evn.target;

      // Anti-loop: se stesso target colpito entro 1ms, avanza leggermente e riprova
      const epsRepeat = 1e-3;
      if(lastHitTarget === tgtSnap.ref && (t1 - lastHitTime) < epsRepeat){
        const tinyAdvance = epsRepeat;
        t0 += tinyAdvance;
        px = px + vx * tinyAdvance;
        py = py + vy * tinyAdvance + 0.5 * gravity * tinyAdvance * tinyAdvance;
        vy = vy + gravity * tinyAdvance;
        ev--;
        continue;
      }

      // Posizione del target al momento della collisione (per calcolo normale)
      const hitGlobalTime = gStart + t1;
      const hasMotion = !!(tgtSnap.ref && tgtSnap.ref.motion);
      const hitPos = hasMotion ? getTargetPositionAtTime(tgtSnap.ref, hitGlobalTime) : tgtSnap;

      // Velocità del target per trasferimento di energia (0 per target statici)
      const tgtVel = hasMotion ? getTargetVelocityAtTime(tgtSnap.ref, hitGlobalTime) : { vx: 0, vy: 0 };

      if(tgtSnap.shape === 'rect'){
        // Rettangolo: normale = direzione dal closest point al centro della palla
        const rect = { x: hitPos.x, y: hitPos.y, width: tgtSnap.width, height: tgtSnap.height, angleRad: tgtSnap.angleRad };
        const contactX = ex, contactY = ey;
        const closest = closestPointOnRotatedRect(contactX, contactY, rect);
        let nx = contactX - closest.x, ny = contactY - closest.y;
        const nlen = Math.hypot(nx,ny) || 1;
        nx /= nlen; ny /= nlen;
        const vix = vx;
        const viy = vy + gravity*dt; // velocità palla al momento dell'impatto
        // Velocità relativa (palla nel frame del target)
        const relVx = vix - tgtVel.vx;
        const relVy = viy - tgtVel.vy;
        // Riflessione della velocità relativa
        const relDotN = relVx*nx + relVy*ny;
        let rx = relVx - 2*relDotN*nx;
        let ry = relVy - 2*relDotN*ny;
        rx *= restitution; ry *= restitution;
        // Ritorno al frame mondo (aggiunta velocità target)
        rx += tgtVel.vx; ry += tgtVel.vy;
        const push = 0.6;
        px = ex + nx * push;
        py = ey + ny * push;
        vx = rx; vy = ry;
      } else {
        // Cerchio: normale = direzione dal centro target al centro palla
        let nx = ex - hitPos.x, ny = ey - hitPos.y;
        const nlen = Math.hypot(nx,ny) || 1;
        nx /= nlen; ny /= nlen;
        const vix = vx;
        const viy = vy + gravity*dt;
        // Velocità relativa (palla nel frame del target)
        const relVx = vix - tgtVel.vx;
        const relVy = viy - tgtVel.vy;
        // Riflessione della velocità relativa
        const relDotN = relVx*nx + relVy*ny;
        let rx = relVx - 2*relDotN*nx;
        let ry = relVy - 2*relDotN*ny;
        rx *= restitution; ry *= restitution;
        // Ritorno al frame mondo
        rx += tgtVel.vx; ry += tgtVel.vy;
        const push = 0.6;
        px = ex + nx * push;
        py = ey + ny * push;
        vx = rx; vy = ry;
      }

      t0 = t1;
      lastHitTarget = tgtSnap.ref;
      lastHitTime = t1;
      continue;
    } else {
      break;
    }
  }
  return segments;
}

/**
 * Tronca la catena di segmenti dopo N rimbalzi (target/wall/ceiling).
 * Usata per la preview (maxBounces da parametri mappa).
 * Se maxBounces ≤ 0, ritorna i segmenti originali (nessun limite).
 */
export function truncateSegmentsByBounces(segments, maxBounces){
  if(!segments || segments.length === 0) return segments;
  if(!maxBounces || maxBounces <= 0) return segments;

  const out = [];
  let count = 0;
  for(const s of segments){
    out.push(s);
    if(s.event === 'target' || s.event === 'wall' || s.event === 'ceiling'){
      count++;
      if(count >= maxBounces) return out;
    }
    if(s.event === 'ground' || s.ground) return out;
  }
  return out;
}

/**
 * Campiona punti dalla catena di segmenti per disegnare la polyline di preview.
 * Distribuisce i campioni proporzionalmente alla durata di ogni segmento.
 *
 * Ogni punto: { x, y, t, event, targetRef }
 *   event = 'target'|'wall'|'ceiling'|'ground'|null (null = punto intermedio)
 *
 * @param {Array} segments    - Catena di segmenti da computeTrajectorySegments
 * @param {number} totalSamples - Numero totale di punti da campionare
 * @param {object} params     - {gravity} per calcolo parabolico
 * @returns {Array<{x,y,t,event,targetRef}>}
 */
export function sampleTrajectory(segments, totalSamples = 300, params = {}){
  const samples = [];
  if(!segments || segments.length===0) return samples;
  // Calcola durata totale per distribuzione proporzionale
  let totalDur = 0;
  for(const s of segments) totalDur += Math.max(0, s.t1 - s.t0);
  if(totalDur <= 0) totalDur = 1;
  for(const s of segments){
    const segDur = Math.max(0, s.t1 - s.t0);
    const frac = segDur / totalDur;
    const segSamples = Math.max(2, Math.round(frac * totalSamples));
    for(let k=0;k<segSamples;k++){
      const tLocal = (k/Math.max(1,segSamples-1)) * (s.t1 - s.t0);
      const x = s.px + s.vx * tLocal;
      const y = s.py + s.vy * tLocal + 0.5 * (params.gravity || 980) * tLocal * tLocal;
      const isLast = (k === segSamples - 1);
      samples.push({ x, y, t: s.t0 + tLocal, event: isLast ? s.event : null, targetRef: isLast ? s.targetRef : null });
    }
  }
  // Assicura che l'ultimo punto corrisponda alla fine della traiettoria
  const last = segments[segments.length-1];
  const finalLocal = last.t1 - last.t0;
  const finalX = last.px + last.vx * finalLocal;
  const finalY = last.py + last.vy * finalLocal + 0.5 * (params.gravity || 980) * finalLocal * finalLocal;
  const lastSample = samples[samples.length-1];
  if(!lastSample || Math.hypot(lastSample.x - finalX, lastSample.y - finalY) > 0.5){
    samples.push({ x: finalX, y: finalY, t: last.t1, event: 'ground', targetRef: null });
  } else {
    if(last.event === 'ground') { lastSample.event = 'ground'; lastSample.targetRef = null; }
  }
  return samples;
}

/**
 * Posizione esatta della palla al tempo fisico t (per animazione frame-by-frame).
 * Cerca il segmento che contiene t, poi calcola la posizione parabolica.
 *
 * @param {Array} segments - Catena di segmenti
 * @param {number} t       - Tempo fisico (secondi)
 * @param {number} gravity - Accelerazione gravitazionale
 * @returns {{x, y, eventAtSegment, segment?} | null}
 */
export function getPositionAtPhysicalTime(segments, t, gravity){
  if(!segments || segments.length === 0) return null;
  let seg = null;
  for(let i=0;i<segments.length;i++){
    const s = segments[i];
    if(t >= s.t0 - 1e-9 && t <= s.t1 + 1e-9){ seg = s; break; }
  }
  if(!seg){
    // Oltre la fine: ritorna posizione finale
    const last = segments[segments.length-1];
    const lastLocal = last.t1 - last.t0;
    const fx = last.px + last.vx * lastLocal;
    const fy = last.py + last.vy * lastLocal + 0.5 * gravity * lastLocal * lastLocal;
    return { x: fx, y: fy, eventAtSegment: last.event || last.ground };
  }
  const dt = t - seg.t0;
  const x = seg.px + seg.vx * dt;
  const y = seg.py + seg.vy * dt + 0.5 * gravity * dt * dt;
  return { x, y, eventAtSegment: seg.event, segment: seg };
}
