/*
 * editor.js — Editor visuale per mappe PaggIa con supporto spline Bezier.
 *
 * ARCHITETTURA:
 *   Sidebar destra con pannelli collapsabili (Parametri Canvas, Fisica, Pallina, Gioco,
 *   Aggiungi Target, Movimento, Target list, Base64 Output).
 *   Canvas a sinistra con rendering target, ghost animato, overlay Bezier interattivo.
 *
 * INTERAZIONE CANVAS:
 *   Priorità mousedown:
 *     1. Hit test handle Bezier (cp1/cp2/end) del target selezionato → drag handle
 *     2. Hit test target → seleziona e drag target
 *     3. Click su spazio vuoto → crea nuovo target alla posizione
 *   Drag:
 *     - dragType='target' → muove il target (+ enforceClosedPath se attivo)
 *     - dragType='cp1_N'/'cp2_N'/'end_N' → muove handle del segmento N
 *     - end dell'ultimo segmento bloccato se closedPath=true
 *   Tastiera: Delete/Backspace → rimuovi target selezionato
 *
 * MOTION EDITOR (pannello "Movimento Target #N"):
 *   - Checkbox "Abilita moto" → crea/rimuove motion con default
 *   - Durata, EaseIn, EaseOut, Teleport, Chiudi percorso
 *   - Lista segmenti Bezier con campi End/CP1/CP2 editabili numericamente
 *   - Bottone "+ Aggiungi segmento"
 *   - Overlay canvas: curva tratteggiata, handle arancioni (cp1/cp2), cerchi ciano (end),
 *     quadrati bianchi (knot tra segmenti), ghost semitrasparente (posizione animata)
 *
 * CLOSED PATH (closedPath):
 *   Quando attivo, l'endpoint dell'ultimo segmento è forzato a (target.x, target.y).
 *   Viene rinforzato su: cambio checkbox, drag target, drag handle, edit numerico,
 *   aggiunta segmento. L'endpoint dell'ultimo segmento non è draggabile.
 *
 * BASE64 EXPORT/IMPORT:
 *   updateBase64() serializza mapData in JSON → btoa → textarea readonly.
 *   L'import fa atob → JSON.parse → applyImportedMap.
 *   Il motion viene deep-copied (JSON.parse/stringify) per evitare shared refs.
 *
 * ANIMAZIONE EDITOR:
 *   Se ci sono target con moto, un loop requestAnimationFrame aggiorna editorClock
 *   e ridisegna il canvas (per il ghost animato).
 *
 * DIPENDENZE: mapLoader.js, motion.js (getTargetPositionAtTime, evaluateSpline)
 * FILE HTML: editor.html
 */
import { loadMap } from './mapLoader.js';
import { getTargetPositionAtTime, evaluateSpline } from './motion.js';

const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');

/* ---------- Stato dell'editor ---------- */
let mapData = {
  canvas: { width: 1000, height: 560 },          // Dimensioni canvas di gioco
  params: {
    gravity: 980, restitution: 0.8, ballRadius: 10, defaultSpeed: 700,
    timeScale: 1, samples: 400, shotsTotal: 10, maxBounces: 0
  },
  targets: []  // Array di {shape, x, y, r?, width?, height?, angle?, motion?}
};

let selectedIndex = -1;       // Indice target selezionato (-1 = nessuno)
let dragging = false;         // true durante drag su canvas
let dragOffset = { x: 0, y: 0 }; // Offset mouse-target per drag fluido
let dragType = null;          // 'target' | 'cp1_N' | 'cp2_N' | 'end_N' (N = indice segmento)

// Clock per animazione ghost dei target mobili nell'editor
let editorClock = 0;          // Secondi dall'avvio animazione editor
let editorClockStart = 0;     // performance.now() all'avvio
let editorAnimRunning = false; // true se il loop di animazione è attivo

/* ---------- Riferimenti DOM (sidebar) ---------- */
const els = {
  // Parametri canvas
  canvasW: document.getElementById('canvasW'),
  canvasH: document.getElementById('canvasH'),
  // Fisica
  gravity: document.getElementById('gravity'),
  restitution: document.getElementById('restitution'),
  // Pallina
  ballRadius: document.getElementById('ballRadius'),
  defaultSpeed: document.getElementById('defaultSpeed'),
  // Gioco
  timeScale: document.getElementById('timeScale'),
  samples: document.getElementById('samples'),
  maxBounces: document.getElementById('maxBounces'),
  shotsTotal: document.getElementById('shotsTotal'),
  // Aggiungi target
  newTargetShape: document.getElementById('newTargetShape'),
  circleFields: document.getElementById('circleFields'),
  rectFields: document.getElementById('rectFields'),
  newCircleR: document.getElementById('newCircleR'),
  newRectW: document.getElementById('newRectW'),
  newRectH: document.getElementById('newRectH'),
  newRectAngle: document.getElementById('newRectAngle'),
  addTargetBtn: document.getElementById('addTargetBtn'),
  // Target list
  targetList: document.getElementById('targetList'),
  targetCount: document.getElementById('targetCount'),
  clearAllTargets: document.getElementById('clearAllTargets'),
  // Base64
  base64Output: document.getElementById('base64Output'),
  copyBase64Btn: document.getElementById('copyBase64Btn'),
  importBase64Btn: document.getElementById('importBase64Btn'),
  // Motion (pannello visibile solo con target selezionato)
  motionSection: document.getElementById('motionSection'),
  motionTargetIdx: document.getElementById('motionTargetIdx'),
  motionEnabled: document.getElementById('motionEnabled'),
  motionFields: document.getElementById('motionFields'),
  motionDuration: document.getElementById('motionDuration'),
  motionEaseIn: document.getElementById('motionEaseIn'),
  motionEaseOut: document.getElementById('motionEaseOut'),
  motionTeleport: document.getElementById('motionTeleport'),
  motionClosedPath: document.getElementById('motionClosedPath'),
  motionSegmentsList: document.getElementById('motionSegmentsList'),
  addSegmentBtn: document.getElementById('addSegmentBtn')
};

/* =====================================================
 *  SYNC UI ↔ mapData
 * ===================================================== */

/** Legge tutti i parametri dalla sidebar e aggiorna mapData. */
function readParamsFromUI(){
  mapData.canvas.width = Math.max(400, Math.min(1600, Number(els.canvasW.value) || 1000));
  mapData.canvas.height = Math.max(300, Math.min(1000, Number(els.canvasH.value) || 560));
  mapData.params.gravity = Number(els.gravity.value) || 980;
  mapData.params.restitution = Number(els.restitution.value) || 0.8;
  mapData.params.ballRadius = Number(els.ballRadius.value) || 10;
  mapData.params.defaultSpeed = Number(els.defaultSpeed.value) || 700;
  mapData.params.timeScale = Number(els.timeScale.value) || 1;
  mapData.params.samples = Number(els.samples.value) || 400;
  mapData.params.maxBounces = Math.max(0, Math.floor(Number(els.maxBounces.value) || 0));
  mapData.params.shotsTotal = Math.max(1, Math.floor(Number(els.shotsTotal.value) || 10));
  if(mapData.params.maxBounces === 0) delete mapData.params.maxBounces;
}

/** Scrive i parametri da mapData nei campi della sidebar. */
function writeParamsToUI(){
  els.canvasW.value = mapData.canvas.width;
  els.canvasH.value = mapData.canvas.height;
  els.gravity.value = mapData.params.gravity;
  els.restitution.value = mapData.params.restitution;
  els.ballRadius.value = mapData.params.ballRadius;
  els.defaultSpeed.value = mapData.params.defaultSpeed;
  els.timeScale.value = mapData.params.timeScale;
  els.samples.value = mapData.params.samples;
  els.maxBounces.value = mapData.params.maxBounces || 0;
  els.shotsTotal.value = mapData.params.shotsTotal;
}

/* =====================================================
 *  DRAWING (Canvas)
 * ===================================================== */

/** Ridimensiona il canvas alle dimensioni della mappa. */
function resizeCanvas(){
  canvas.width = mapData.canvas.width;
  canvas.height = mapData.canvas.height;
}

/**
 * Ridisegna l'intero canvas dell'editor:
 * cannone, pareti, ground, target (con indice), ghost animato, overlay Bezier.
 */
function drawEditor(){
  const w = canvas.width, h = canvas.height;
  const br = mapData.params.ballRadius || 10;

  ctx.clearRect(0, 0, w, h);

  // Cannone (cerchio grigio, centro-alto)
  ctx.fillStyle = '#999';
  ctx.beginPath(); ctx.arc(w / 2, 40, 14, 0, Math.PI * 2); ctx.fill();

  // Soffitto e pareti (linee guida)
  ctx.strokeStyle = '#666'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, br); ctx.lineTo(w, br);       // soffitto
  ctx.moveTo(br, 0); ctx.lineTo(br, h);       // parete sinistra
  ctx.moveTo(w - br, 0); ctx.lineTo(w - br, h); // parete destra
  ctx.stroke();

  // Ground
  ctx.strokeStyle = '#444';
  ctx.beginPath(); ctx.moveTo(0, h - 20); ctx.lineTo(w, h - 20); ctx.stroke();

  // Target
  mapData.targets.forEach((t, i) => {
    const isSelected = (i === selectedIndex);

    // Target alla posizione base (statica)
    drawTargetShape(t, isSelected, t.x, t.y);

    // Etichetta indice al centro del target
    ctx.fillStyle = '#000';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, t.x, t.y);

    // Ghost semitrasparente alla posizione animata (solo target con motion)
    if(t.motion && t.motion.segments && t.motion.segments.length > 0){
      const animPos = getTargetPositionAtTime(t, editorClock);
      ctx.globalAlpha = 0.3;
      drawTargetShape(t, false, animPos.x, animPos.y);
      ctx.globalAlpha = 1.0;
    }

    // Overlay spline Bezier (solo target selezionato con motion)
    if(isSelected && t.motion && t.motion.segments && t.motion.segments.length > 0){
      drawSplineOverlay(t);
    }
  });

  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** Disegna la forma di un target (cerchio o rettangolo ruotato). */
function drawTargetShape(t, isSelected, px, py){
  if(t.shape === 'rect'){
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate((t.angle || 0) * Math.PI / 180);
    ctx.fillStyle = isSelected ? '#0df' : '#0af';
    ctx.fillRect(-t.width / 2, -t.height / 2, t.width, t.height);
    if(isSelected){
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.strokeRect(-t.width / 2, -t.height / 2, t.width, t.height);
    }
    ctx.restore();
  } else {
    ctx.fillStyle = isSelected ? '#0df' : '#0af';
    ctx.beginPath(); ctx.arc(px, py, t.r, 0, Math.PI * 2); ctx.fill();
    if(isSelected){
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

/**
 * Disegna l'overlay della spline Bezier per il target selezionato:
 * - Curva tratteggiata ciano (40 punti per segmento)
 * - Linee handle arancioni (segStart→cp1, end→cp2)
 * - Cerchi arancioni pieni per cp1/cp2 (r=5)
 * - Cerchi ciano vuoti per endpoint (r=7)
 * - Quadrati bianchi per knot intermedi (tra segmenti, 6x6)
 */
function drawSplineOverlay(t){
  const m = t.motion;
  const segs = m.segments;
  const startPt = { x: t.x, y: t.y };

  ctx.save();

  // Curva tratteggiata — disegna l'intera spline
  ctx.strokeStyle = 'rgba(0,170,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  const totalPoints = segs.length * 40;
  for(let k = 0; k <= totalPoints; k++){
    const pt = evaluateSpline(k / totalPoints, startPt, segs);
    if(k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Handle per ogni segmento
  segs.forEach((seg, si) => {
    const segStart = si === 0 ? startPt : segs[si - 1].end;

    // Linee handle (segStart→cp1, end→cp2) — arancione semitrasparente
    ctx.strokeStyle = 'rgba(255,136,0,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(segStart.x, segStart.y); ctx.lineTo(seg.cp1.x, seg.cp1.y);
    ctx.moveTo(seg.end.x, seg.end.y); ctx.lineTo(seg.cp2.x, seg.cp2.y);
    ctx.stroke();

    // Control points cp1/cp2 — cerchi arancioni pieni
    ctx.fillStyle = '#f80';
    ctx.beginPath(); ctx.arc(seg.cp1.x, seg.cp1.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(seg.cp2.x, seg.cp2.y, 5, 0, Math.PI * 2); ctx.fill();

    // Endpoint — cerchio ciano vuoto
    ctx.strokeStyle = '#0af'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(seg.end.x, seg.end.y, 7, 0, Math.PI * 2); ctx.stroke();

    // Knot intermedio (punto di giunzione tra segmenti, tranne P0 che è il target)
    if(si > 0){
      ctx.fillStyle = '#fff';
      ctx.fillRect(segStart.x - 3, segStart.y - 3, 6, 6);
    }
  });

  ctx.restore();
}

/* =====================================================
 *  MOTION UI (pannello sidebar)
 * ===================================================== */

/** Mostra/nasconde il pannello motion in base al target selezionato. */
function showMotionPanel(){
  if(selectedIndex < 0){
    els.motionSection.style.display = 'none';
    return;
  }
  els.motionSection.style.display = '';
  els.motionTargetIdx.textContent = selectedIndex + 1;

  const t = mapData.targets[selectedIndex];
  const hasMotion = !!(t.motion && t.motion.segments && t.motion.segments.length > 0);
  els.motionEnabled.checked = hasMotion;
  els.motionFields.style.display = hasMotion ? '' : 'none';

  if(hasMotion){
    els.motionDuration.value = t.motion.duration || 2;
    els.motionEaseIn.value = t.motion.easeIn ?? 0.25;
    els.motionEaseOut.value = t.motion.easeOut ?? 0.25;
    els.motionTeleport.checked = !!t.motion.teleport;
    els.motionClosedPath.checked = !!t.motion.closedPath;
    renderMotionSegments();
  }
}

/**
 * Renderizza la lista dei segmenti Bezier nella sidebar.
 * Ogni segmento mostra: End(x,y), CP1(x,y), CP2(x,y) con input editabili + bottone elimina.
 * Wires: input change → aggiorna segmento → enforceClosedPath → ridisegna.
 */
function renderMotionSegments(){
  const t = mapData.targets[selectedIndex];
  if(!t || !t.motion) return;
  els.motionSegmentsList.innerHTML = '';

  t.motion.segments.forEach((seg, si) => {
    const div = document.createElement('div');
    div.className = 'motion-segment-item';
    div.innerHTML = `
      <div class="seg-header">
        <span class="small">Segmento ${si + 1}</span>
        <button class="del-btn" data-seg="${si}" title="Rimuovi">×</button>
      </div>
      <div class="seg-fields">
        <div class="field-row"><label>End</label>
          <input type="number" data-seg="${si}" data-field="endX" value="${Math.round(seg.end.x)}" style="width:60px">
          <input type="number" data-seg="${si}" data-field="endY" value="${Math.round(seg.end.y)}" style="width:60px">
        </div>
        <div class="field-row"><label>CP1</label>
          <input type="number" data-seg="${si}" data-field="cp1X" value="${Math.round(seg.cp1.x)}" style="width:60px">
          <input type="number" data-seg="${si}" data-field="cp1Y" value="${Math.round(seg.cp1.y)}" style="width:60px">
        </div>
        <div class="field-row"><label>CP2</label>
          <input type="number" data-seg="${si}" data-field="cp2X" value="${Math.round(seg.cp2.x)}" style="width:60px">
          <input type="number" data-seg="${si}" data-field="cp2Y" value="${Math.round(seg.cp2.y)}" style="width:60px">
        </div>
      </div>`;
    els.motionSegmentsList.appendChild(div);
  });

  // Wire: input numerici → aggiorna segmento
  els.motionSegmentsList.querySelectorAll('input[data-seg]').forEach(inp => {
    inp.addEventListener('input', () => {
      const si = Number(inp.dataset.seg);
      const seg = t.motion.segments[si];
      if(!seg) return;
      const v = Number(inp.value) || 0;
      switch(inp.dataset.field){
        case 'endX': seg.end.x = v; break;
        case 'endY': seg.end.y = v; break;
        case 'cp1X': seg.cp1.x = v; break;
        case 'cp1Y': seg.cp1.y = v; break;
        case 'cp2X': seg.cp2.x = v; break;
        case 'cp2Y': seg.cp2.y = v; break;
      }
      if(t.motion.closedPath) enforceClosedPath(t);
      drawEditor();
      updateBase64();
    });
  });

  // Wire: bottoni elimina segmento
  els.motionSegmentsList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const si = Number(btn.dataset.seg);
      t.motion.segments.splice(si, 1);
      if(t.motion.segments.length === 0) delete t.motion;
      showMotionPanel();
      drawEditor();
      updateBase64();
    });
  });
}

/**
 * Forza l'endpoint dell'ultimo segmento a coincidere con (target.x, target.y).
 * Chiamata quando closedPath è attivo: su drag target, edit numerico, aggiunta segmento.
 */
function enforceClosedPath(t){
  if(!t.motion || !t.motion.segments || t.motion.segments.length === 0) return;
  const lastSeg = t.motion.segments[t.motion.segments.length - 1];
  lastSeg.end.x = t.x;
  lastSeg.end.y = t.y;
}

/** Legge i parametri motion dalla sidebar e aggiorna mapData. */
function readMotionFromUI(){
  if(selectedIndex < 0) return;
  const t = mapData.targets[selectedIndex];
  if(!t.motion) return;
  t.motion.duration = Math.max(0.1, Number(els.motionDuration.value) || 2);
  t.motion.easeIn = Math.max(0, Math.min(0.5, Number(els.motionEaseIn.value) || 0));
  t.motion.easeOut = Math.max(0, Math.min(0.5, Number(els.motionEaseOut.value) || 0));
  t.motion.teleport = els.motionTeleport.checked;
  t.motion.closedPath = els.motionClosedPath.checked;
  if(t.motion.closedPath) enforceClosedPath(t);
}

/** Crea un motion di default per un target: 1 segmento, arco a destra. */
function createDefaultMotion(target){
  const dx = 200;
  return {
    segments: [
      {
        cp1: { x: target.x + dx * 0.33, y: target.y - 60 },
        cp2: { x: target.x + dx * 0.66, y: target.y - 60 },
        end: { x: target.x + dx, y: target.y }
      }
    ],
    duration: 2.0,
    easeIn: 0.25,
    easeOut: 0.25,
    teleport: false
  };
}

/* --- Event listeners motion --- */

// Checkbox "Abilita moto"
els.motionEnabled.addEventListener('change', () => {
  if(selectedIndex < 0) return;
  const t = mapData.targets[selectedIndex];
  if(els.motionEnabled.checked){
    if(!t.motion) t.motion = createDefaultMotion(t);
  } else {
    delete t.motion;
  }
  showMotionPanel();
  drawEditor();
  updateBase64();
  manageEditorAnimation();
});

// Input numerici motion (duration, easeIn, easeOut)
[els.motionDuration, els.motionEaseIn, els.motionEaseOut].forEach(inp => {
  inp.addEventListener('input', () => {
    readMotionFromUI();
    updateBase64();
  });
});

// Checkbox teleport
els.motionTeleport.addEventListener('change', () => {
  readMotionFromUI();
  updateBase64();
});

// Checkbox "Chiudi percorso" — forza endpoint ultimo segmento = punto iniziale target
els.motionClosedPath.addEventListener('change', () => {
  readMotionFromUI();
  renderMotionSegments();
  drawEditor();
  updateBase64();
});

// Bottone "+ Aggiungi segmento"
els.addSegmentBtn.addEventListener('click', () => {
  if(selectedIndex < 0) return;
  const t = mapData.targets[selectedIndex];
  if(!t.motion) return;
  const segs = t.motion.segments;
  const lastEnd = segs.length > 0 ? segs[segs.length - 1].end : { x: t.x, y: t.y };
  const dx = 150;
  segs.push({
    cp1: { x: lastEnd.x + dx * 0.33, y: lastEnd.y - 50 },
    cp2: { x: lastEnd.x + dx * 0.66, y: lastEnd.y - 50 },
    end: { x: lastEnd.x + dx, y: lastEnd.y }
  });
  if(t.motion.closedPath) enforceClosedPath(t);
  renderMotionSegments();
  drawEditor();
  updateBase64();
});

/* =====================================================
 *  TARGET LIST (sidebar)
 * ===================================================== */

/** Renderizza la lista target nella sidebar. Click → seleziona, × → elimina. */
function renderTargetList(){
  els.targetCount.textContent = mapData.targets.length;
  els.targetList.innerHTML = '';

  mapData.targets.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'target-item' + (i === selectedIndex ? ' selected' : '');
    const hasMotion = t.motion && t.motion.segments && t.motion.segments.length > 0;
    let info;
    if(t.shape === 'rect'){
      info = `#${i+1} Rect (${Math.round(t.x)}, ${Math.round(t.y)}) ${t.width}×${t.height} ${t.angle||0}°`;
    } else {
      info = `#${i+1} Cerchio (${Math.round(t.x)}, ${Math.round(t.y)}) r=${t.r}`;
    }
    if(hasMotion) info += ' ~'; // Indicatore moto nella lista

    div.innerHTML = `<span class="info">${info}</span><button class="del-btn" data-idx="${i}" title="Rimuovi">×</button>`;
    div.addEventListener('click', (e) => {
      if(e.target.classList.contains('del-btn')) return;
      selectedIndex = i;
      renderTargetList();
      showMotionPanel();
      drawEditor();
    });
    els.targetList.appendChild(div);
  });

  // Wire: bottoni elimina target
  els.targetList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      mapData.targets.splice(idx, 1);
      if(selectedIndex >= mapData.targets.length) selectedIndex = mapData.targets.length - 1;
      refresh();
    });
  });
}

/* =====================================================
 *  BASE64 OUTPUT
 * ===================================================== */

/**
 * Serializza mapData → JSON → btoa → textarea.
 * Formato export: { canvas, params, targets[] } dove ogni target ha optional motion.
 * Motion export include: segments[], duration, easeIn, easeOut, teleport, closedPath.
 */
function updateBase64(){
  const exportData = {
    canvas: { ...mapData.canvas },
    params: { ...mapData.params },
    targets: mapData.targets.map(t => {
      const base = t.shape === 'rect'
        ? { shape: 'rect', x: t.x, y: t.y, width: t.width, height: t.height, angle: t.angle || 0 }
        : { shape: 'circle', x: t.x, y: t.y, r: t.r };
      if(t.motion && t.motion.segments && t.motion.segments.length > 0){
        base.motion = {
          segments: t.motion.segments.map(s => ({
            cp1: { x: s.cp1.x, y: s.cp1.y },
            cp2: { x: s.cp2.x, y: s.cp2.y },
            end: { x: s.end.x, y: s.end.y }
          })),
          duration: t.motion.duration,
          easeIn: t.motion.easeIn,
          easeOut: t.motion.easeOut,
          teleport: t.motion.teleport,
          closedPath: !!t.motion.closedPath
        };
      }
      return base;
    })
  };
  const json = JSON.stringify(exportData);
  els.base64Output.value = btoa(json);
}

/* =====================================================
 *  FULL REFRESH
 * ===================================================== */

/** Aggiorna tutto: legge parametri, ridimensiona canvas, ridisegna, aggiorna base64. */
function refresh(){
  readParamsFromUI();
  resizeCanvas();
  drawEditor();
  renderTargetList();
  showMotionPanel();
  updateBase64();
  manageEditorAnimation();
}

/* =====================================================
 *  ANIMAZIONE EDITOR (ghost target mobili)
 * ===================================================== */

/** Avvia/ferma il loop di animazione in base alla presenza di target con moto. */
function manageEditorAnimation(){
  const hasMoving = mapData.targets.some(t => t.motion && t.motion.segments && t.motion.segments.length > 0);
  if(hasMoving && !editorAnimRunning){
    editorClockStart = performance.now();
    editorAnimRunning = true;
    requestAnimationFrame(editorTick);
  } else if(!hasMoving){
    editorAnimRunning = false;
  }
}

/** Frame del loop animazione: aggiorna clock e ridisegna. */
function editorTick(now){
  if(!editorAnimRunning) return;
  editorClock = (now - editorClockStart) / 1000;
  drawEditor();
  requestAnimationFrame(editorTick);
}

/* =====================================================
 *  EVENT LISTENERS (sidebar parametri + canvas)
 * ===================================================== */

// Qualsiasi cambio nei parametri sidebar → refresh completo
const paramInputs = [
  els.canvasW, els.canvasH, els.gravity, els.restitution,
  els.ballRadius, els.defaultSpeed, els.timeScale, els.samples,
  els.maxBounces, els.shotsTotal
];
paramInputs.forEach(input => { input.addEventListener('input', refresh); });

// Toggle forma target (cerchio/rettangolo) → mostra/nascondi campi
els.newTargetShape.addEventListener('change', () => {
  const isRect = els.newTargetShape.value === 'rect';
  els.circleFields.style.display = isRect ? 'none' : '';
  els.rectFields.style.display = isRect ? '' : 'none';
});

// Bottone "Aggiungi al centro"
els.addTargetBtn.addEventListener('click', () => {
  const shape = els.newTargetShape.value;
  const cx = mapData.canvas.width / 2, cy = mapData.canvas.height / 2;
  if(shape === 'rect'){
    mapData.targets.push({ shape: 'rect', x: cx, y: cy, width: Number(els.newRectW.value) || 80, height: Number(els.newRectH.value) || 36, angle: Number(els.newRectAngle.value) || 0 });
  } else {
    mapData.targets.push({ shape: 'circle', x: cx, y: cy, r: Number(els.newCircleR.value) || 18 });
  }
  selectedIndex = mapData.targets.length - 1;
  refresh();
});

// Rimuovi tutti i target
els.clearAllTargets.addEventListener('click', () => {
  mapData.targets = [];
  selectedIndex = -1;
  refresh();
});

// Copia base64 negli appunti
els.copyBase64Btn.addEventListener('click', () => {
  navigator.clipboard.writeText(els.base64Output.value).then(() => {
    const orig = els.copyBase64Btn.textContent;
    els.copyBase64Btn.textContent = 'Copiato!';
    setTimeout(() => { els.copyBase64Btn.textContent = orig; }, 1200);
  });
});

// Importa da base64 (prompt)
els.importBase64Btn.addEventListener('click', () => {
  const raw = prompt('Incolla il base64 della mappa:');
  if(!raw) return;
  try {
    const json = atob(raw.trim());
    const data = JSON.parse(json);
    applyImportedMap(data);
  } catch(err){
    alert('Base64 non valido o JSON malformato');
  }
});

/* =====================================================
 *  INTERAZIONE CANVAS (hit test, drag, click-to-place)
 * ===================================================== */

/** Converte coordinate mouse → coordinate canvas (gestisce scaling CSS). */
function getCanvasPos(e){
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

/** Hit test su tutti i target (ultimo in alto ha priorità). Ritorna indice o -1. */
function hitTestTarget(px, py){
  for(let i = mapData.targets.length - 1; i >= 0; i--){
    const t = mapData.targets[i];
    if(t.shape === 'rect'){
      // Trasforma nel frame locale del rettangolo
      const a = -(t.angle || 0) * Math.PI / 180;
      const dx = px - t.x, dy = py - t.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if(Math.abs(lx) <= t.width / 2 + 4 && Math.abs(ly) <= t.height / 2 + 4) return i;
    } else {
      const dx = px - t.x, dy = py - t.y;
      if(dx * dx + dy * dy <= (t.r + 4) ** 2) return i;
    }
  }
  return -1;
}

/**
 * Hit test sugli handle Bezier del target selezionato.
 * Controlla end, cp1, cp2 di ogni segmento (hit radius = 10px).
 * Priorità: ultimo segmento → primo (per z-order).
 * @returns {{ type:'end'|'cp1'|'cp2', seg:number } | null}
 */
function hitTestHandles(px, py){
  if(selectedIndex < 0) return null;
  const t = mapData.targets[selectedIndex];
  if(!t.motion || !t.motion.segments) return null;
  const HR = 10; // hit radius in pixel
  for(let si = t.motion.segments.length - 1; si >= 0; si--){
    const seg = t.motion.segments[si];
    const de = Math.hypot(px - seg.end.x, py - seg.end.y);
    if(de <= HR) return { type: 'end', seg: si };
    const d1 = Math.hypot(px - seg.cp1.x, py - seg.cp1.y);
    if(d1 <= HR) return { type: 'cp1', seg: si };
    const d2 = Math.hypot(px - seg.cp2.x, py - seg.cp2.y);
    if(d2 <= HR) return { type: 'cp2', seg: si };
  }
  return null;
}

// MOUSEDOWN: hit test prioritizzato (handle Bezier > target > spazio vuoto)
canvas.addEventListener('mousedown', (e) => {
  const pos = getCanvasPos(e);

  // Priorità 1: Handle Bezier del target selezionato
  const handle = hitTestHandles(pos.x, pos.y);
  if(handle){
    dragging = true;
    dragType = `${handle.type}_${handle.seg}`;
    dragOffset.x = 0;
    dragOffset.y = 0;
    document.body.classList.add('dragging-target');
    return;
  }

  // Priorità 2: Target
  const hit = hitTestTarget(pos.x, pos.y);
  if(hit >= 0){
    selectedIndex = hit;
    dragging = true;
    dragType = 'target';
    dragOffset.x = pos.x - mapData.targets[hit].x;
    dragOffset.y = pos.y - mapData.targets[hit].y;
    document.body.classList.add('dragging-target');
    renderTargetList();
    showMotionPanel();
    drawEditor();
  } else {
    // Priorità 3: Click su spazio vuoto → piazza nuovo target
    const shape = els.newTargetShape.value;
    if(shape === 'rect'){
      mapData.targets.push({ shape: 'rect', x: Math.round(pos.x), y: Math.round(pos.y), width: Number(els.newRectW.value) || 80, height: Number(els.newRectH.value) || 36, angle: Number(els.newRectAngle.value) || 0 });
    } else {
      mapData.targets.push({ shape: 'circle', x: Math.round(pos.x), y: Math.round(pos.y), r: Number(els.newCircleR.value) || 18 });
    }
    selectedIndex = mapData.targets.length - 1;
    refresh();
  }
});

// MOUSEMOVE: drag handle Bezier o target
canvas.addEventListener('mousemove', (e) => {
  if(!dragging) return;
  const pos = getCanvasPos(e);

  if(dragType && dragType !== 'target'){
    // Drag di un handle Bezier (cp1_N, cp2_N, end_N)
    const [type, segStr] = dragType.split('_');
    const si = Number(segStr);
    const t = mapData.targets[selectedIndex];
    if(!t || !t.motion || !t.motion.segments[si]) return;
    const seg = t.motion.segments[si];
    const rx = Math.round(pos.x), ry = Math.round(pos.y);
    if(type === 'cp1'){ seg.cp1.x = rx; seg.cp1.y = ry; }
    else if(type === 'cp2'){ seg.cp2.x = rx; seg.cp2.y = ry; }
    else if(type === 'end'){
      // Endpoint dell'ultimo segmento bloccato se closedPath attivo
      if(t.motion.closedPath && si === t.motion.segments.length - 1) return;
      seg.end.x = rx; seg.end.y = ry;
    }
    renderMotionSegments();
    drawEditor();
    updateBase64();
    return;
  }

  // Drag di un target
  const t = mapData.targets[selectedIndex];
  if(!t) return;
  t.x = Math.round(pos.x - dragOffset.x);
  t.y = Math.round(pos.y - dragOffset.y);
  if(t.motion && t.motion.closedPath) enforceClosedPath(t);
  drawEditor();
  renderTargetList();
  updateBase64();
});

// MOUSEUP / MOUSELEAVE: fine drag
canvas.addEventListener('mouseup', () => {
  if(dragging){ dragging = false; dragType = null; document.body.classList.remove('dragging-target'); }
});

canvas.addEventListener('mouseleave', () => {
  if(dragging){ dragging = false; dragType = null; document.body.classList.remove('dragging-target'); }
});

// KEYBOARD: Delete/Backspace → rimuovi target selezionato (solo se focus non su input)
document.addEventListener('keydown', (e) => {
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex >= 0){
    e.preventDefault();
    mapData.targets.splice(selectedIndex, 1);
    if(selectedIndex >= mapData.targets.length) selectedIndex = mapData.targets.length - 1;
    refresh();
  }
});

/* =====================================================
 *  IMPORT MAPPA
 * ===================================================== */

/**
 * Applica una mappa importata (da JSON o base64).
 * Deep-copia motion per evitare shared refs.
 * Resetta selezione e aggiorna tutto.
 */
function applyImportedMap(data){
  mapData.canvas.width = data.canvas?.width || 1000;
  mapData.canvas.height = data.canvas?.height || 560;
  mapData.params = {
    gravity: data.params?.gravity ?? 980,
    restitution: data.params?.restitution ?? 0.8,
    ballRadius: data.params?.ballRadius ?? 10,
    defaultSpeed: data.params?.defaultSpeed ?? 700,
    timeScale: data.params?.timeScale ?? 1,
    samples: data.params?.samples ?? 400,
    shotsTotal: data.params?.shotsTotal ?? 10,
    maxBounces: data.params?.maxBounces ?? 0
  };
  mapData.targets = (data.targets || []).map(t => {
    const base = t.shape === 'rect'
      ? { shape: 'rect', x: t.x, y: t.y, width: t.width || 40, height: t.height || 20, angle: t.angle || 0 }
      : { shape: 'circle', x: t.x || 0, y: t.y || 0, r: t.r || 12 };
    if(t.motion) base.motion = JSON.parse(JSON.stringify(t.motion)); // deep copy
    return base;
  });
  selectedIndex = -1;
  writeParamsToUI();
  refresh();
}

/* =====================================================
 *  INIT
 * ===================================================== */

/** Carica la mappa di default e inizializza l'editor. */
async function init(){
  const defaultMap = await loadMap('./map.json');
  if(defaultMap){
    applyImportedMap(defaultMap);
  } else {
    refresh();
  }
}

init();
