// engine.js
export const EPS = 1e-9;

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

export function reflectVelocity(vx, vy, nx, ny, restitution){
  const vDotN = vx*nx + vy*ny;
  let rx = vx - 2*vDotN*nx;
  let ry = vy - 2*vDotN*ny;
  rx *= restitution; ry *= restitution;
  return { vx: rx, vy: ry };
}

/* Helpers per rettangoli ruotati */
function worldToRectLocal(px, py, rect){
  const cx = rect.x, cy = rect.y;
  const a = -rect.angleRad;
  const dx = px - cx, dy = py - cy;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  return {
    x: dx * cosA - dy * sinA,
    y: dx * sinA + dy * cosA
  };
}

function closestPointOnRotatedRect(px, py, rect){
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

/* findNextEvent (come prima) */
export function findNextEvent(px,py,vx,vy,t0, snapshotTargets, params){
  const { gravity, ballRadius, canvasWidth, canvasHeight } = params;
  let best = null;

  // ground
  {
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

  // ceiling (y = ballRadius)
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

  // walls
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

  // targets (supporta circle e rect) tramite campionamento + bisezione
  for(const tgt of snapshotTargets){
    if(tgt.removed) continue;

    if(tgt.shape === 'rect'){
      const rect = { x: tgt.x, y: tgt.y, width: tgt.width, height: tgt.height, angleRad: (tgt.angleRad ?? 0) };
      const f = (t) => {
        const x = px + vx*t;
        const y = py + vy*t + 0.5*gravity*t*t;
        const closest = closestPointOnRotatedRect(x, y, rect);
        const dx = x - closest.x, dy = y - closest.y;
        return dx*dx + dy*dy - (ballRadius * ballRadius);
      };
      const Tmax = 5.0;
      const steps = 120;
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
    } else {
      const cx = tgt.x, cy = tgt.y, rsum = (tgt.r || 0) + ballRadius;
      const f = (t) => {
        const x = px + vx*t;
        const y = py + vy*t + 0.5*gravity*t*t;
        const dx = x - cx, dy = y - cy;
        return dx*dx + dy*dy - rsum*rsum;
      };
      const Tmax = 5.0;
      const steps = 120;
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

/* computeTrajectorySegments (come prima) */
export function computeTrajectorySegments(initX, initY, initVx, initVy, params){
  const { gravity, restitution, ballRadius, canvasWidth, canvasHeight } = params;
  const segments = [];
  let px = initX, py = initY, vx = initVx, vy = initVy;
  let t0 = 0;
  const maxEvents = 120;
  const snapshot = params.targets.map(t => ({
    x: t.x, y: t.y, r: t.r, removed: t.removed, ref: t,
    shape: t.shape || 'circle',
    width: t.width, height: t.height,
    angle: t.angle || 0,
    angleRad: ((t.angle || 0) * Math.PI / 180)
  }));
  let lastHitTarget = null;
  let lastHitTime = -1;

  for(let ev=0; ev<maxEvents; ev++){
    const evn = findNextEvent(px,py,vx,vy,t0, snapshot, params);
    if(!evn) break;
    const dt = evn.dt;
    const t1 = t0 + dt;
    const targetRef = evn.target ? evn.target.ref : null;
    segments.push({ t0, t1, px, py, vx, vy, event: evn.type, targetRef, wallX: evn.wallX });

    const ex = px + vx*dt;
    const ey = py + vy*dt + 0.5*gravity*dt*dt;

    if(evn.type === 'ground'){
      segments.push({ t0: t1, t1: t1, px: ex, py: ey, vx: 0, vy: 0, ground:true });
      break;
    } else if(evn.type === 'ceiling'){
      const vix = vx;
      const viy = vy + gravity*dt;
      const newVy = -viy * restitution;
      const newVx = vix;
      const push = 0.6;
      px = ex;
      py = ballRadius + push;
      vx = newVx;
      vy = newVy;
      t0 = t1;
      lastHitTarget = null;
      lastHitTime = -1;
      continue;
    } else if(evn.type === 'wall'){
      const nx = (evn.wallX === ballRadius) ? 1 : -1;
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

      if(tgtSnap.shape === 'rect'){
        const rect = { x: tgtSnap.x, y: tgtSnap.y, width: tgtSnap.width, height: tgtSnap.height, angleRad: tgtSnap.angleRad };
        const contactX = ex, contactY = ey;
        const closest = closestPointOnRotatedRect(contactX, contactY, rect);
        let nx = contactX - closest.x, ny = contactY - closest.y;
        const nlen = Math.hypot(nx,ny) || 1;
        nx /= nlen; ny /= nlen;
        const vix = vx;
        const viy = vy + gravity*dt;
        const vDotN = vix*nx + viy*ny;
        let rx = vix - 2*vDotN*nx;
        let ry = viy - 2*vDotN*ny;
        rx *= restitution; ry *= restitution;
        const push = 0.6;
        px = ex + nx * push;
        py = ey + ny * push;
        vx = rx; vy = ry;
      } else {
        let nx = ex - tgtSnap.x, ny = ey - tgtSnap.y;
        const nlen = Math.hypot(nx,ny) || 1;
        nx /= nlen; ny /= nlen;
        const vix = vx;
        const viy = vy + gravity*dt;
        const vDotN = vix*nx + viy*ny;
        let rx = vix - 2*vDotN*nx;
        let ry = viy - 2*vDotN*ny;
        rx *= restitution; ry *= restitution;
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

/* Nuova funzione: tronca i segments dopo N rimbalzi (target/wall/ceiling)
   maxBounces: intero >0; se <=0 ritorna i segments originali (nessun limite)
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
      if(count >= maxBounces){
        // stop here: include this segment (evento) and return
        return out;
      }
    }
    // if ground encountered, stop anyway
    if(s.event === 'ground' || s.ground) return out;
  }
  return out;
}

export function sampleTrajectory(segments, totalSamples = 300, params = {}){
  const samples = [];
  if(!segments || segments.length===0) return samples;
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

export function getPositionAtPhysicalTime(segments, t, gravity){
  if(!segments || segments.length === 0) return null;
  let seg = null;
  for(let i=0;i<segments.length;i++){
    const s = segments[i];
    if(t >= s.t0 - 1e-9 && t <= s.t1 + 1e-9){ seg = s; break; }
  }
  if(!seg){
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
