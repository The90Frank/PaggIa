/*
 * motion.js — Modulo matematico per il moto dei target lungo spline di Bezier cubiche.
 *
 * ARCHITETTURA:
 *   Ogni target può avere un campo `motion` con un array di N segmenti Bezier cubici
 *   concatenati. Il percorso parte da (target.x, target.y) e attraversa i segmenti in ordine.
 *   Il tempo è distribuito equamente tra i segmenti.
 *
 * FORMATO DATI (in map.json / base64):
 *   motion: {
 *     segments: [{ cp1:{x,y}, cp2:{x,y}, end:{x,y} }, ...],  // N segmenti Bezier cubici
 *     duration: number,    // secondi per una traversata completa (andata)
 *     easeIn: number,      // frazione (0-0.5) per accelerazione iniziale
 *     easeOut: number,     // frazione (0-0.5) per decelerazione finale
 *     teleport: boolean,   // true = teletrasporto a inizio, false = ping-pong
 *     closedPath: boolean  // true = endpoint ultimo segmento = punto iniziale target
 *   }
 *
 * FUNZIONI ESPORTATE:
 *   cubicBezier(t, p0, p1, p2, p3)        → punto su singola Bezier cubica
 *   evaluateSpline(t, startPoint, segs)    → punto sulla spline composita (t ∈ [0,1])
 *   applyEasing(linearT, easeIn, easeOut)  → t rimappato con smoothstep piecewise
 *   getMotionProgress(globalTime, dur, tp) → progresso lineare [0,1] con periodicità
 *   getTargetPositionAtTime(target, time)  → {x,y} posizione al tempo globale
 *   getTargetVelocityAtTime(target, time)  → {vx,vy} velocità in px/s (differenze finite)
 *
 * USATO DA: engine.js (collision detection), game.js (rendering), editor.js (preview/overlay)
 */

/**
 * Punto su una singola curva di Bezier cubica.
 * Formula: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 * @param {number} t - Parametro [0,1]
 * @param {{x:number,y:number}} p0 - Punto iniziale
 * @param {{x:number,y:number}} p1 - Primo control point
 * @param {{x:number,y:number}} p2 - Secondo control point
 * @param {{x:number,y:number}} p3 - Punto finale
 * @returns {{x:number,y:number}}
 */
export function cubicBezier(t, p0, p1, p2, p3){
  const u = 1 - t;
  const uu = u * u, uuu = uu * u;
  const tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

/**
 * Punto sulla spline composita (N segmenti Bezier cubici concatenati).
 * Il tempo t ∈ [0,1] è diviso equamente tra gli N segmenti.
 * Segmento i parte da segments[i-1].end (o startPoint per i=0).
 * @param {number} t - Parametro globale [0,1]
 * @param {{x:number,y:number}} startPoint - Punto iniziale della spline (= target.x/y)
 * @param {Array<{cp1:{x,y}, cp2:{x,y}, end:{x,y}}>} segments - Array di segmenti
 * @returns {{x:number,y:number}}
 */
export function evaluateSpline(t, startPoint, segments){
  if(!segments || segments.length === 0) return { x: startPoint.x, y: startPoint.y };

  const n = segments.length;
  const clamped = Math.max(0, Math.min(1, t));
  // Mappa t globale → indice segmento + t locale
  const scaled = clamped * n;
  const idx = Math.min(Math.floor(scaled), n - 1);
  const localT = scaled - idx;

  const seg = segments[idx];
  const segStart = idx === 0 ? startPoint : segments[idx - 1].end;

  return cubicBezier(localT, segStart, seg.cp1, seg.cp2, seg.end);
}

/**
 * Applica easing (accelerazione/decelerazione) a un valore di progresso lineare.
 * Usa smoothstep piecewise: s(u) = 3u² - 2u³ (derivate zero agli estremi).
 *
 * Zone:
 *   [0, easeIn]       → accelerazione (smoothstep 0→easeIn)
 *   [easeIn, 1-easeOut] → velocità costante (lineare)
 *   [1-easeOut, 1]    → decelerazione (smoothstep inverso)
 *
 * @param {number} linearT - Progresso lineare [0,1]
 * @param {number} easeIn  - Frazione durata accelerazione (0-0.5)
 * @param {number} easeOut - Frazione durata decelerazione (0-0.5)
 * @returns {number} Progresso con easing [0,1]
 */
export function applyEasing(linearT, easeIn, easeOut){
  let ei = Math.max(0, Math.min(0.5, easeIn || 0));
  let eo = Math.max(0, Math.min(0.5, easeOut || 0));
  // Normalizza se la somma supera 1
  if(ei + eo > 1){ const s = 1 / (ei + eo); ei *= s; eo *= s; }

  const t = Math.max(0, Math.min(1, linearT));
  if(ei <= 0 && eo <= 0) return t;

  // Zona ease-in
  if(t <= ei && ei > 0){
    const u = t / ei;
    const smooth = u * u * (3 - 2 * u); // smoothstep
    return smooth * ei;
  }

  // Zona ease-out
  if(t >= 1 - eo && eo > 0){
    const u = (1 - t) / eo;
    const smooth = u * u * (3 - 2 * u);
    return 1 - smooth * eo;
  }

  // Zona lineare centrale
  return t;
}

/**
 * Calcola il progresso del moto [0,1] in base al tempo globale.
 * Gestisce la periodicità: ping-pong (teleport=false) o teletrasporto (teleport=true).
 *
 * Ping-pong: periodo = 2 * duration (andata e ritorno)
 * Teleport:  periodo = duration (reset istantaneo a inizio)
 *
 * @param {number} globalTime - Secondi dall'inizio del livello
 * @param {number} duration   - Secondi per una traversata completa
 * @param {boolean} teleport  - Modalità teletrasporto
 * @returns {number} Progresso lineare [0,1]
 */
export function getMotionProgress(globalTime, duration, teleport){
  if(duration <= 0) return 0;
  const time = Math.max(0, globalTime);

  if(teleport){
    // Teletrasporto: ripartire da 0 ogni volta che si raggiunge 1
    return (time % duration) / duration;
  }

  // Ping-pong: andata 0→1, ritorno 1→0
  const period = 2 * duration;
  const phase = time % period;
  return phase <= duration
    ? phase / duration
    : 1 - (phase - duration) / duration;
}

/**
 * Posizione di un target al tempo globale dato.
 * Se il target non ha motion, ritorna la posizione statica (retrocompatibile).
 * Catena: globalTime → linearProgress → easedProgress → evaluateSpline → {x,y}
 *
 * @param {object} target     - Oggetto target con optional `motion`
 * @param {number} globalTime - Secondi dall'inizio del livello
 * @returns {{x:number, y:number}}
 */
export function getTargetPositionAtTime(target, globalTime){
  if(!target.motion || !target.motion.segments || target.motion.segments.length === 0){
    return { x: target.x, y: target.y };
  }

  const m = target.motion;
  const linearProgress = getMotionProgress(globalTime, m.duration, m.teleport);
  const easedProgress = applyEasing(linearProgress, m.easeIn || 0, m.easeOut || 0);
  const startPoint = { x: target.x, y: target.y };

  return evaluateSpline(easedProgress, startPoint, m.segments);
}

/**
 * Velocità di un target mobile al tempo globale (in px/s).
 * Usa differenze finite centrali per robustezza — gestisce automaticamente
 * tutta la catena (easing + ping-pong + spline) senza derivate analitiche.
 *
 * Ritorna {vx:0, vy:0} per target statici (retrocompatibile).
 *
 * USATO DA: engine.js per il trasferimento di energia nelle collisioni.
 * Un target che si muove verso la palla le trasferisce energia (come una racchetta).
 *
 * @param {object} target     - Oggetto target
 * @param {number} globalTime - Secondi dall'inizio del livello
 * @returns {{vx:number, vy:number}}
 */
export function getTargetVelocityAtTime(target, globalTime){
  if(!target.motion || !target.motion.segments || target.motion.segments.length === 0){
    return { vx: 0, vy: 0 };
  }

  const eps = 0.0005; // 0.5ms — piccolo per accuratezza, grande abbastanza per stabilità
  const p0 = getTargetPositionAtTime(target, globalTime - eps);
  const p1 = getTargetPositionAtTime(target, globalTime + eps);

  return {
    vx: (p1.x - p0.x) / (2 * eps),
    vy: (p1.y - p0.y) / (2 * eps)
  };
}
