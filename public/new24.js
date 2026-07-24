// 피팅샷 v2.4 — v2.3의 3단계 흐름(옷 실측 → 핏 지시사항 → 합성)을 유지하되 두 가지가 다릅니다:
//  1) 비율 잠금: 사진만으로는 옷 절대 cm를 못 맞추므로, 한 값을 실측으로 고치고 [이 값 기준]을
//     누르면 측정선이 있는 나머지 항목이 사진 속 픽셀 비율대로 자동 보정됩니다.
//  2) 착지점 계산은 코드(fit-mapper)가 결정론적으로 수행 → LLM(핏 모델)은 그 FIT MAP을 문장화만.
// 모델 분석/옷 분석 API는 v2.3(/api/v23/*)을 그대로 재사용하고, 핏 지시/합성만 /api/v24/*를 씁니다.

const statusEl = document.getElementById('status');
const modelFile = document.getElementById('modelFile');
const topFile = document.getElementById('topFile');
const bottomFile = document.getElementById('bottomFile');
const modelThumb = document.getElementById('modelThumb');
const topThumb = document.getElementById('topThumb');
const bottomThumb = document.getElementById('bottomThumb');
const analyzeBtn = document.getElementById('analyzeBtn');
const instructionsBtn = document.getElementById('instructionsBtn');
const synthBtn = document.getElementById('synthBtn');
const topSpecBox = document.getElementById('topSpecBox');
const bottomSpecBox = document.getElementById('bottomSpecBox');
const specPlaceholder = document.getElementById('specPlaceholder');
const analyzeModelBtn = document.getElementById('analyzeModelBtn');
const modelSpecBox = document.getElementById('modelSpecBox');
const modelSpecPlaceholder = document.getElementById('modelSpecPlaceholder');
const modeSeparateBtn = document.getElementById('modeSeparateBtn');
const modeDressBtn = document.getElementById('modeDressBtn');
const dressFile = document.getElementById('dressFile');
const dressThumb = document.getElementById('dressThumb');
const dressSpecBox = document.getElementById('dressSpecBox');
const clearResultsBtn = document.getElementById('clearResultsBtn');
const fitMapWrap = document.getElementById('fitMapWrap');

// 옷 분석에 쓸 모델(한 줄 라디오).
function selectedAnalysisModel() {
  const checked = document.querySelector('input[name="analysisModel"]:checked');
  return checked ? checked.value : 'gemini-3.5-flash';
}
// 핏 지시사항(FIT MAP 문장화)에 쓸 모델.
function selectedFittingModel() {
  const checked = document.querySelector('input[name="fittingModel"]:checked');
  return checked ? checked.value : 'gemini-3.5-flash';
}
const engineChecks = document.getElementById('engineChecks');
const engineAllBtn = document.getElementById('engineAllBtn');
const noInstrCheck = document.getElementById('noInstrCheck');

const ENGINES = [
  { value: 'gemini', label: 'Gemini (기본)' },
  { value: 'gpt-image-2-high', label: 'GPT Image-2 (High)' },
  { value: 'gpt-image-2-medium', label: 'GPT Image-2 (Medium)' },
  { value: 'seedream-4.5', label: 'Seedream 4.5' },
  { value: 'seedream-5.0-lite', label: 'Seedream 5.0-lite' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'og-medium', label: 'OG 2K' },
  { value: 'og-high', label: 'OG 4K' },
];
const ENGINE_LABELS = Object.fromEntries(ENGINES.map((e) => [e.value, e.label]));

for (const eng of ENGINES) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = eng.value;
  cb.checked = eng.value === 'gemini';
  cb.addEventListener('change', refreshButtonStates);
  label.appendChild(cb);
  label.appendChild(document.createTextNode(' ' + eng.label));
  engineChecks.appendChild(label);
}
function selectedEngines() {
  return [...engineChecks.querySelectorAll('input:checked')].map((cb) => cb.value);
}
engineAllBtn.addEventListener('click', () => {
  const boxes = [...engineChecks.querySelectorAll('input')];
  const allOn = boxes.every((cb) => cb.checked);
  boxes.forEach((cb) => { cb.checked = !allOn; });
  engineAllBtn.textContent = allOn ? '전체선택' : '전체해제';
  refreshButtonStates();
});
noInstrCheck.addEventListener('change', refreshButtonStates);
const modelElapsed = document.getElementById('modelElapsed');
const instrElapsed = document.getElementById('instrElapsed');
const topElapsed = document.getElementById('topElapsed');
const bottomElapsed = document.getElementById('bottomElapsed');
const instructionsWrap = document.getElementById('instructionsWrap');
const instructionsPlaceholder = document.getElementById('instructionsPlaceholder');
const resultWrap = document.getElementById('resultWrap');
const modalOverlay = document.getElementById('modalOverlay');
const modalImg = document.getElementById('modalImg');

let topSpec = null;
let bottomSpec = null;
let dressSpec = null;
let topSpecImg = null;
let bottomSpecImg = null;
let dressSpecImg = null;

let mode = 'separate';
const isDress = () => mode === 'dress';

let modelSpec = null;
let modelSpecImg = null;
const MODEL_FIELDS = [
  { key: 'height_cm', label: '키', unit: 'cm' },
  { key: 'weight_kg', label: '몸무게', unit: 'kg' },
  { key: 'shoulder_width_cm', label: '어깨너비', unit: 'cm' },
  { key: 'chest_cm', label: '가슴둘레', unit: 'cm' },
  { key: 'waist_cm', label: '허리둘레', unit: 'cm' },
  { key: 'hip_cm', label: '엉덩이둘레', unit: 'cm' },
  { key: 'arm_length_cm', label: '팔길이 (어깨~손목)', unit: 'cm' },
  { key: 'torso_length_cm', label: '상체길이 (어깨~허리)', unit: 'cm' },
  { key: 'leg_length_cm', label: '다리길이 (허리~바닥)', unit: 'cm' },
];

let fittingItems = [];
let lastFitMap = null; // 코드가 계산한 FIT MAP(착지점 요약) — 화면 표시용

function setStatus(text) { statusEl.textContent = text; }

function startTimer(el, label) {
  const t0 = performance.now();
  el.className = 'elapsed';
  el.textContent = '';
  return {
    stop(ok = true) {
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      el.className = ok ? 'elapsed' : 'elapsed failed';
      el.textContent = ok ? `${label} ${secs}초` : `${label} 실패 (${secs}초)`;
    },
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function parseJsonOrThrow(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`서버가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

function bindThumbPreview(input, thumbEl) {
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) { thumbEl.classList.remove('show'); }
    else { thumbEl.src = await fileToDataUrl(file); thumbEl.classList.add('show'); }
    refreshButtonStates();
  });
}
bindThumbPreview(modelFile, modelThumb);
bindThumbPreview(topFile, topThumb);
bindThumbPreview(bottomFile, bottomThumb);
bindThumbPreview(dressFile, dressThumb);

function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-separate', !isDress());
  document.body.classList.toggle('mode-dress', isDress());
  modeSeparateBtn.classList.toggle('active', !isDress());
  modeDressBtn.classList.toggle('active', isDress());
  fittingItems = [];
  lastFitMap = null;
  renderFitMap();
  renderFittingItems();
  refreshButtonStates();
}
modeSeparateBtn.addEventListener('click', () => setMode('separate'));
modeDressBtn.addEventListener('click', () => setMode('dress'));

modalOverlay.addEventListener('click', () => modalOverlay.classList.remove('show'));
function openModal(src) {
  if (!src) return;
  modalImg.src = src;
  modalOverlay.classList.add('show');
}

function allImagesPresent() {
  if (isDress()) return !!(modelFile.files[0] && dressFile.files[0]);
  return !!(modelFile.files[0] && topFile.files[0] && bottomFile.files[0]);
}

function specsReady() {
  return isDress() ? !!dressSpec : !!(topSpec && bottomSpec);
}

function hasInstructions() {
  return fittingItems.some((item) => item.instruction.trim());
}

function refreshButtonStates() {
  analyzeModelBtn.disabled = !modelFile.files[0];
  analyzeBtn.disabled = !allImagesPresent();
  instructionsBtn.disabled = !(specsReady() && modelSpec);
  const instrOk = hasInstructions() || (noInstrCheck && noInstrCheck.checked);
  const engineOk = engineChecks && engineChecks.querySelector('input:checked');
  synthBtn.disabled = !(allImagesPresent() && instrOk && engineOk);
  clearResultsBtn.disabled = !resultWrap.firstChild;
}

// ---- 모델 신체 실측 렌더링 (v2.3과 동일 — 비율 잠금 대상 아님; 키 입력이 기준) ----
function renderModelSpec() {
  modelSpecBox.innerHTML = '';
  modelSpecPlaceholder.style.display = modelSpec ? 'none' : '';
  if (!modelSpec) return;

  if (modelSpecImg && (modelSpec.lines || []).length) {
    const overlay = document.createElement('canvas');
    overlay.className = 'specOverlay';
    const drawn = renderOverlayCanvas(modelSpecImg, modelSpec.lines, 560);
    overlay.width = drawn.width;
    overlay.height = drawn.height;
    overlay.getContext('2d').drawImage(drawn, 0, 0);
    overlay.addEventListener('click', () => {
      openModal(renderOverlayCanvas(modelSpecImg, modelSpec.lines, 1100).toDataURL('image/png'));
    });
    modelSpecBox.appendChild(overlay);
  }

  const rows = document.createElement('div');
  rows.className = 'modelRows';
  modelSpecBox.appendChild(rows);

  for (const field of MODEL_FIELDS) {
    const row = document.createElement('div');
    row.className = 'specRow';
    const label = document.createElement('div');
    label.className = 'specLabel';
    label.textContent = field.label;
    const value = document.createElement('input');
    value.type = 'number';
    value.step = '0.1';
    value.className = 'specValue';
    value.value = modelSpec[field.key];
    value.addEventListener('input', () => { modelSpec[field.key] = parseFloat(value.value); });
    const unit = document.createElement('span');
    unit.className = 'specUnit';
    unit.textContent = field.unit;
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(unit);
    rows.appendChild(row);
  }
}

// ---- 옷 사진 위 치수 화살표 오버레이 (v2.3과 동일) ----
const OVERLAY_COLORS = ['#e74c3c', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#c0392b', '#2c3e50'];

function drawArrowhead(ctx, x, y, angle, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.45);
  ctx.lineTo(-size, size * 0.45);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function renderOverlayCanvas(img, items, width) {
  const canvas = document.createElement('canvas');
  const scale = width / img.naturalWidth;
  canvas.width = width;
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const fontPx = Math.max(10, Math.round(width * 0.026));
  ctx.font = `700 ${fontPx}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';

  const drawable = (items || []).filter(
    (m) => m.x1 != null && m.y1 != null && m.x2 != null && m.y2 != null,
  );

  const lines = drawable.map((m, i) => {
    const color = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
    const x1 = (m.x1 / 1000) * canvas.width, y1 = (m.y1 / 1000) * canvas.height;
    const x2 = (m.x2 / 1000) * canvas.width, y2 = (m.y2 / 1000) * canvas.height;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, width * 0.004);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headSize = Math.max(6, width * 0.016);
    drawArrowhead(ctx, x2, y2, angle, headSize, color);
    drawArrowhead(ctx, x1, y1, angle + Math.PI, headSize, color);
    return { m, color, x1, y1, x2, y2 };
  });

  const padX = fontPx * 0.4;
  const boxH = fontPx * 1.55;
  const step = boxH * 1.15;
  const placed = [];
  const T_CANDIDATES = [0.5, 0.36, 0.64, 0.24, 0.76, 0.14, 0.86];
  const OFFSETS = [0, 1, -1, 2, -2, 3, -3];

  for (const line of lines) {
    const { m, color, x1, y1, x2, y2 } = line;
    const text = `${m.label} ${m.value_cm}`;
    const boxW = ctx.measureText(text).width + padX * 2;

    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;

    let best = null;
    let fallback = null;
    outer:
    for (const off of OFFSETS) {
      for (const t of T_CANDIDATES) {
        const ax = x1 + dx * t, ay = y1 + dy * t;
        let cx = ax + nx * step * off;
        let cy = ay + ny * step * off;
        cx = Math.min(canvas.width - boxW / 2 - 2, Math.max(boxW / 2 + 2, cx));
        cy = Math.min(canvas.height - boxH / 2 - 2, Math.max(boxH / 2 + 2, cy));
        const rect = { x: cx - boxW / 2, y: cy - boxH / 2, w: boxW, h: boxH };
        if (!fallback) fallback = { rect, cx, cy, ax, ay, off };
        if (!placed.some((p) => rectsOverlap(p, rect))) {
          best = { rect, cx, cy, ax, ay, off };
          break outer;
        }
      }
    }
    const pick = best || fallback;
    if (!pick) continue;
    placed.push(pick.rect);

    if (pick.off !== 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pick.ax, pick.ay);
      ctx.lineTo(pick.cx, pick.cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(pick.rect.x, pick.rect.y, pick.rect.w, pick.rect.h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(pick.rect.x, pick.rect.y, pick.rect.w, pick.rect.h);
    ctx.fillStyle = color;
    ctx.fillText(text, pick.rect.x + padX, pick.cy);
  }

  if (lines.length) {
    const unitPx = Math.max(9, Math.round(width * 0.019));
    ctx.font = `600 ${unitPx}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(90,80,100,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText('단위: cm', canvas.width - unitPx, canvas.height - unitPx);
    ctx.textAlign = 'left';
  }
  return canvas;
}

// 옷 사진 위 치수 화살표 표시 여부(체크박스). 끄면 화살표·라벨·"단위: cm" 없이 원본 사진만
// 보여줍니다. 모델에 따라 화살표 위치가 잘 안 맞을 때 사진만 깨끗하게 보려는 용도입니다.
// (수치 자체와 비율 잠금은 그대로 동작합니다 — 표시만 끄는 것)
const showArrowsCheck = document.getElementById('showArrowsCheck');
function arrowsEnabled() {
  return !showArrowsCheck || showArrowsCheck.checked;
}
function renderSpecOverlayCanvas(img, spec, width) {
  return renderOverlayCanvas(img, arrowsEnabled() ? spec.measurements : [], width);
}
if (showArrowsCheck) {
  // 켜고 끌 때 이미 그려진 상의/하의/원피스 오버레이를 다시 그립니다.
  // (수치·자물쇠·AI 추정 상태는 spec 객체에 있으므로 재렌더해도 보존됩니다.)
  showArrowsCheck.addEventListener('change', renderSpecs);
}

const includeDescState = { top: false, bottom: false, dress: false };

// ---- 비율 잠금 헬퍼 ----
// 측정선(x1,y1→x2,y2, 0~1000 정규화)을 실제 이미지 크기로 복원해 픽셀 길이를 잽니다.
// 가로선/세로선을 같은 물리 스케일로 비교하려면 반드시 각 축을 naturalWidth/Height로 되돌려야 합니다.
function measurePixelLen(m, img) {
  if (!img) return null;
  if (m.x1 == null || m.y1 == null || m.x2 == null || m.y2 == null) return null;
  const dx = ((m.x2 - m.x1) / 1000) * img.naturalWidth;
  const dy = ((m.y2 - m.y1) / 1000) * img.naturalHeight;
  const len = Math.hypot(dx, dy);
  return len > 0.5 ? len : null;
}
// 자물쇠가 잠긴(연동) 항목은 사진 픽셀 길이에 비례하는 하나의 스케일 k를 공유합니다.
// 잠긴 항목 하나(anchor)를 고치면 k = anchor.value / pixelLen(anchor)로 다시 잡고,
// 잠긴 나머지 항목의 값을 k × pixelLen으로 재계산합니다. 풀린 항목/측정선 없는 항목은 제외.
function propagateLocked(spec, img, anchor, rowRefs) {
  const anchorLen = measurePixelLen(anchor, img);
  const anchorVal = parseFloat(anchor.value_cm);
  if (!anchorLen || !Number.isFinite(anchorVal)) return;
  const k = anchorVal / anchorLen;
  for (const ref of rowRefs) {
    if (ref.m === anchor) continue;
    if (!ref.m._locked || !ref.hasLine) continue;
    const v = Math.round(k * ref.len * 2) / 2; // 0.5cm 반올림
    ref.m.value_cm = v;
    ref.input.value = v; // 포커스를 잃지 않도록 형제 입력칸만 직접 갱신
    ref.m._ai = false;   // 연동으로 재계산된 값은 더 이상 AI 초기 추정치가 아님
    if (ref.badge) ref.badge.classList.add('hidden');
  }
}

// 옷 한 벌을 "설명 + 치수 화살표 사진(위) + 실측 항목(아래, 비율 잠금)" 형태로 그립니다.
function renderSpecBox(container, spec, img, title, slotKey) {
  container.innerHTML = '';
  if (!spec) return;

  const groupTitle = document.createElement('div');
  groupTitle.className = 'instrGroupTitle';
  groupTitle.textContent = title;
  container.appendChild(groupTitle);

  const includeWrap = document.createElement('label');
  includeWrap.className = 'descInclude';
  const includeCheck = document.createElement('input');
  includeCheck.type = 'checkbox';
  includeCheck.checked = includeDescState[slotKey];
  includeCheck.addEventListener('change', () => { includeDescState[slotKey] = includeCheck.checked; });
  includeWrap.appendChild(includeCheck);
  includeWrap.appendChild(document.createTextNode(' 옷 종류/설명을 최종 프롬프트에 포함하기'));
  container.appendChild(includeWrap);

  const typeWrap = document.createElement('div');
  typeWrap.className = 'specTypeRow';
  const typeLabel = document.createElement('div');
  typeLabel.className = 'specLabel';
  typeLabel.textContent = '옷 종류';
  const typeInput = document.createElement('input');
  typeInput.type = 'text';
  typeInput.className = 'specTypeInput';
  typeInput.value = spec.garment_type || '';
  typeInput.addEventListener('input', () => { spec.garment_type = typeInput.value; });
  typeWrap.appendChild(typeLabel);
  typeWrap.appendChild(typeInput);
  container.appendChild(typeWrap);

  const desc = document.createElement('div');
  desc.className = 'specDesc';
  const descLabel = document.createElement('div');
  descLabel.className = 'specSubLabel';
  descLabel.textContent = '옷 설명 (위 체크박스를 켜면 최종 프롬프트의 GARMENT DESCRIPTION으로 들어감)';
  desc.appendChild(descLabel);
  const descText = document.createElement('textarea');
  descText.spellcheck = false;
  descText.value = spec.description || '';
  descText.addEventListener('input', () => { spec.description = descText.value; });
  desc.appendChild(descText);
  container.appendChild(desc);

  let overlay = null;
  const redrawOverlay = () => {
    if (!img || !overlay) return;
    const drawn = renderSpecOverlayCanvas(img, spec, 760);
    overlay.width = drawn.width;
    overlay.height = drawn.height;
    overlay.getContext('2d').drawImage(drawn, 0, 0);
  };
  if (img) {
    overlay = document.createElement('canvas');
    overlay.className = 'specOverlay';
    overlay.addEventListener('click', () => {
      openModal(renderSpecOverlayCanvas(img, spec, 1100).toDataURL('image/png'));
    });
    container.appendChild(overlay);
    redrawOverlay();
  }

  // 각 치수 행: 라벨 + 값 + 단위 + 자물쇠(연동 토글). 측정선이 있는 항목만 연동 가능하며,
  // 그런 항목은 기본으로 잠금(연동)됩니다. 측정선이 없으면 연동 불가라 자물쇠가 비활성.
  const rowRefs = [];
  const measures = spec.measurements || [];

  // 맨 위 마스터 자물쇠: 연동 가능한 항목 전체를 한 번에 잠금/풀림.
  const master = document.createElement('div');
  master.className = 'specMasterLock';
  const masterBtn = document.createElement('button');
  masterBtn.type = 'button';
  const masterHint = document.createElement('span');
  masterHint.className = 'mlHint';
  masterHint.textContent = '잠긴 항목끼리 비율 연동';
  master.appendChild(masterBtn);
  master.appendChild(masterHint);
  if (measures.length) container.appendChild(master);

  const applyLockVisual = (ref) => {
    ref.lockBtn.textContent = ref.m._locked ? '🔒' : '🔓';
    ref.lockBtn.className = 'lockBtn ' + (!ref.hasLine ? 'disabled' : ref.m._locked ? 'locked' : 'unlocked');
    ref.input.classList.toggle('unlinked', ref.hasLine && !ref.m._locked);
  };
  const refreshMaster = () => {
    const lockable = rowRefs.filter((r) => r.hasLine);
    const allLocked = lockable.length > 0 && lockable.every((r) => r.m._locked);
    masterBtn.textContent = allLocked ? '🔒 전체 잠김' : '🔓 전체 잠금';
    masterBtn.disabled = lockable.length === 0;
  };
  masterBtn.addEventListener('click', () => {
    const lockable = rowRefs.filter((r) => r.hasLine);
    const allLocked = lockable.length > 0 && lockable.every((r) => r.m._locked);
    const target = !allLocked; // 전부 잠겨 있으면 전체 풀기, 아니면 전체 잠금
    for (const ref of lockable) { ref.m._locked = target; applyLockVisual(ref); }
    refreshMaster();
  });

  measures.forEach((m) => {
    const len = measurePixelLen(m, img);
    const hasLine = len != null;
    // 최초 렌더 시 기본 잠금 상태 설정(측정선 있으면 연동, 없으면 연동 불가).
    if (m._locked === undefined) m._locked = hasLine;
    // 아직 AI가 추측한 초기값인지 여부(직접 고치거나 연동 재계산되면 false).
    if (m._ai === undefined) m._ai = true;

    const row = document.createElement('div');
    row.className = 'specRow';
    const label = document.createElement('div');
    label.className = 'specLabel';
    label.textContent = m.label;
    const value = document.createElement('input');
    value.type = 'number';
    value.step = '0.1';
    value.className = 'specValue';
    value.value = m.value_cm;
    const unit = document.createElement('span');
    unit.className = 'specUnit';
    unit.textContent = 'cm';
    const aiTag = document.createElement('span');
    aiTag.className = 'aiTag' + (m._ai ? '' : ' hidden');
    aiTag.textContent = 'AI 추정';
    aiTag.title = 'AI가 사진만 보고 추측한 초기값입니다. 실측을 알면 고쳐주세요.';
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.title = hasLine
      ? '잠금(🔒): 다른 잠긴 항목과 비율 연동 / 풀림(🔓): 이 값은 연동에서 제외(독립)'
      : '측정선이 없어 비율 연동을 할 수 없는 항목입니다.';

    const ref = { m, input: value, lockBtn, badge: aiTag, hasLine, len };
    rowRefs.push(ref);
    applyLockVisual(ref);

    value.addEventListener('input', () => {
      m.value_cm = parseFloat(value.value);
      m._ai = false;                 // 직접 고친 값은 AI 추정이 아님
      aiTag.classList.add('hidden');
      // 이 값이 잠겨 있고 측정선이 있으면, 잠긴 나머지 항목을 비율대로 함께 재계산.
      if (m._locked && hasLine) propagateLocked(spec, img, m, rowRefs);
      redrawOverlay();
    });
    lockBtn.addEventListener('click', () => {
      if (!hasLine) return; // 연동 불가 항목은 토글 없음
      m._locked = !m._locked;
      applyLockVisual(ref);
      refreshMaster();
    });

    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(unit);
    row.appendChild(aiTag);
    row.appendChild(lockBtn);
    container.appendChild(row);
  });
  refreshMaster();
}

function renderSpecs() {
  const any = isDress() ? dressSpec : (topSpec || bottomSpec);
  specPlaceholder.style.display = any ? 'none' : '';
  renderSpecBox(topSpecBox, topSpec, topSpecImg, '상의', 'top');
  renderSpecBox(bottomSpecBox, bottomSpec, bottomSpecImg, '하의', 'bottom');
  renderSpecBox(dressSpecBox, dressSpec, dressSpecImg, '원피스', 'dress');
}

function loadImageFromFile(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

const INSTRUCTION_GROUPS = [
  { key: 'top', label: '상의' },
  { key: 'bottom', label: '하의' },
  { key: 'dress', label: '원피스' },
  { key: 'overall', label: '전체 / 레이어링' },
];

const INSTR_LINE_PX = 18;
const INSTR_PAD_PX = 22;
function autoSizeInstr(textarea) {
  if (!textarea.isConnected) return;
  const minPx = INSTR_LINE_PX + INSTR_PAD_PX;
  const maxPx = INSTR_LINE_PX * 5 + INSTR_PAD_PX;
  textarea.style.height = 'auto';
  const needed = textarea.scrollHeight;
  textarea.style.height = `${Math.min(Math.max(needed, minPx), maxPx)}px`;
  textarea.style.overflowY = needed > maxPx ? 'auto' : 'hidden';
}

// ---- FIT MAP(코드가 계산한 착지점) 읽기전용 요약 렌더 ----
const FITMAP_SLOT_LABEL = { top: '상의', bottom: '하의', dress: '원피스' };
function renderFitMap() {
  fitMapWrap.innerHTML = '';
  if (!lastFitMap) return;
  const box = document.createElement('div');
  box.className = 'fitMap';
  const h = document.createElement('h3');
  h.textContent = '코드가 계산한 착지점 (FIT MAP · 재계산 없음)';
  box.appendChild(h);

  if ((lastFitMap.ladder || []).length) {
    const ladder = document.createElement('div');
    ladder.className = 'ladder';
    ladder.textContent = '모델 세로 사다리(cm): ' + lastFitMap.ladder.map((l) => `${l.name} ${l.h}`).join(' / ');
    box.appendChild(ladder);
  }

  for (const g of (lastFitMap.garments || [])) {
    const gd = document.createElement('div');
    gd.className = 'fmGarment';
    const type = document.createElement('div');
    type.className = 'fmType';
    type.textContent = `[${FITMAP_SLOT_LABEL[g.slot] || g.slot}] ${g.type}`;
    gd.appendChild(type);
    for (const r of (g.rows || [])) {
      const row = document.createElement('div');
      row.className = 'fmRow';
      const b = document.createElement('b');
      b.textContent = r.label + ': ';
      row.appendChild(b);
      row.appendChild(document.createTextNode(r.result));
      gd.appendChild(row);
    }
    box.appendChild(gd);
  }
  fitMapWrap.appendChild(box);
}

function renderFittingItems() {
  instructionsWrap.innerHTML = '';
  instructionsPlaceholder.style.display = (fittingItems.length || lastFitMap) ? 'none' : '';

  for (const group of INSTRUCTION_GROUPS) {
    const indices = fittingItems
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.garment === group.key);
    if (indices.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'instrGroup';
    const title = document.createElement('div');
    title.className = 'instrGroupTitle';
    title.textContent = group.label;
    section.appendChild(title);

    for (const { item, index } of indices) {
      const row = document.createElement('div');
      row.className = 'instrRow';
      const cat = document.createElement('div');
      cat.className = 'instrCat';
      cat.textContent = item.category;
      const text = document.createElement('textarea');
      text.className = 'instrText';
      text.rows = 1;
      text.spellcheck = false;
      text.value = item.instruction;
      text.addEventListener('input', () => {
        fittingItems[index].instruction = text.value;
        autoSizeInstr(text);
        refreshButtonStates();
      });
      row.appendChild(cat);
      row.appendChild(text);
      section.appendChild(row);
    }
    instructionsWrap.appendChild(section);
  }

  for (const textarea of instructionsWrap.querySelectorAll('.instrText')) autoSizeInstr(textarea);
}

// ---- 1단계: 모델 체형 분석 (v2.3 엔드포인트 재사용) ----
analyzeModelBtn.addEventListener('click', async () => {
  if (!modelFile.files[0]) { setStatus('모델 이미지를 먼저 선택하세요.'); return; }
  analyzeModelBtn.disabled = true;
  setStatus('모델 사진에서 신체 실측을 추정하는 중...');
  const timer = startTimer(modelElapsed, '모델');
  try {
    const modelDataUrl = await fileToDataUrl(modelFile.files[0]);
    const res = await fetch('/api/v23/analyze-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelDataUrl }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    modelSpec = data.model;
    modelSpecImg = await loadImageFromFile(modelFile.files[0]);
    renderModelSpec();
    timer.stop(true);
    setStatus('모델 체형 분석 완료. 값을 확인/수정한 뒤 [옷 분석]으로 진행하세요.');
  } catch (err) {
    console.error(err);
    timer.stop(false);
    setStatus('실패: ' + err.message);
  } finally {
    refreshButtonStates();
  }
});

// ---- 2단계: 옷 실측 분석 (v2.3 엔드포인트 재사용) ----
analyzeBtn.addEventListener('click', async () => {
  if (!allImagesPresent()) { setStatus('모델/상의/하의 이미지를 모두 선택하세요.'); return; }
  analyzeBtn.disabled = true;
  setStatus('옷 사진에서 실측(cm)과 측정 위치를 추정하는 중... (상/하의 병렬)');

  const analyzeOne = async (slot, file, elapsedEl, label) => {
    const timer = startTimer(elapsedEl, label);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await fetch('/api/v23/analyze-garments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ garment: dataUrl, slot, analysisModel: selectedAnalysisModel() }),
      });
      const data = await parseJsonOrThrow(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const img = await loadImageFromFile(file);
      if (slot === 'top') { topSpec = data.spec; topSpecImg = img; }
      else if (slot === 'dress') { dressSpec = data.spec; dressSpecImg = img; }
      else { bottomSpec = data.spec; bottomSpecImg = img; }
      renderSpecs();
      timer.stop(true);
      return true;
    } catch (err) {
      console.error(err);
      timer.stop(false);
      setStatus(`${label} 분석 실패: ${err.message}`);
      return false;
    }
  };

  const results = isDress()
    ? await Promise.all([analyzeOne('dress', dressFile.files[0], topElapsed, '원피스')])
    : await Promise.all([
      analyzeOne('top', topFile.files[0], topElapsed, '상의'),
      analyzeOne('bottom', bottomFile.files[0], bottomElapsed, '하의'),
    ]);
  if (results.every(Boolean)) {
    setStatus('옷 실측 분석 완료. 아는 실측이 있으면 값을 고치고 [이 값 기준]으로 나머지를 비율 보정한 뒤 [피팅 지시사항 생성]을 누르세요.');
  }
  refreshButtonStates();
});

// ---- 3단계: 핏/기장 지시사항 생성 (v2.4 — 코드가 FIT MAP 계산 후 선택 모델이 문장화) ----
instructionsBtn.addEventListener('click', async () => {
  if (!(specsReady() && modelSpec)) { setStatus('먼저 모델 체형 분석과 옷 실측 분석을 완료하세요.'); return; }
  instructionsBtn.disabled = true;
  setStatus('코드가 착지점(FIT MAP)을 계산하고, 선택한 모델이 문장으로 옮기는 중...');
  const timer = startTimer(instrElapsed, '지시사항');
  try {
    const payload = { modelSpec, fittingModel: selectedFittingModel() };
    if (isDress()) {
      payload.dress = await fileToDataUrl(dressFile.files[0]);
      payload.dressSpec = dressSpec;
    } else {
      const [topDataUrl, bottomDataUrl] = await Promise.all([
        fileToDataUrl(topFile.files[0]), fileToDataUrl(bottomFile.files[0]),
      ]);
      Object.assign(payload, { top: topDataUrl, bottom: bottomDataUrl, topSpec, bottomSpec });
    }
    const res = await fetch('/api/v24/fitting-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastFitMap = data.fitMap || null;
    fittingItems = data.items || [];
    renderFitMap();
    renderFittingItems();
    timer.stop(true);
    setStatus('피팅 지시사항 생성 완료. 위 FIT MAP은 코드가 계산한 착지점이고, 아래 문장은 직접 수정할 수 있습니다.');
  } catch (err) {
    console.error(err);
    timer.stop(false);
    setStatus('실패: ' + err.message);
  } finally {
    refreshButtonStates();
  }
});

// ---- 결과 그리드 헬퍼 ----
function appendResultItem(src, labelText) {
  const item = document.createElement('div');
  item.className = 'resultItem';
  const img = document.createElement('img');
  img.src = src;
  img.addEventListener('click', () => openModal(img.src));
  const label = document.createElement('span');
  label.className = 'resultLabel';
  label.textContent = labelText;
  item.appendChild(img);
  item.appendChild(label);
  resultWrap.appendChild(item);
  refreshButtonStates();
  return item;
}
let synthCount = 0;

function appendPendingResultItem(labelText) {
  const item = document.createElement('div');
  item.className = 'resultItem pending';
  const box = document.createElement('div');
  box.className = 'pendingBox';
  box.innerHTML = '<div class="spinner"></div>';
  const label = document.createElement('span');
  label.className = 'resultLabel';
  label.textContent = labelText || '생성 중...';
  item.appendChild(box);
  item.appendChild(label);
  resultWrap.appendChild(item);
  refreshButtonStates();
  return { item, box, label };
}

clearResultsBtn.addEventListener('click', () => {
  resultWrap.innerHTML = '';
  synthCount = 0;
  setStatus('합성 결과를 초기화했습니다.');
  refreshButtonStates();
});

function runSynthShot(basePayload, engine) {
  const engineLabel = ENGINE_LABELS[engine] || engine;
  const shotNo = ++synthCount;
  const shotStart = performance.now();
  const shotSecs = () => ((performance.now() - shotStart) / 1000).toFixed(1);
  const { item, box, label } = appendPendingResultItem(`${shotNo}번 · ${engineLabel} · 생성 중...`);

  (async () => {
    try {
      const res = await fetch('/api/v24/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basePayload, engine }),
      });
      const data = await parseJsonOrThrow(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      box.remove();
      const img = document.createElement('img');
      img.src = data.resultDataUrls[0];
      img.addEventListener('click', () => openModal(img.src));
      item.classList.remove('pending');
      item.insertBefore(img, label);
      const took = shotSecs();
      label.textContent = data.resultDataUrls.length > 1
        ? `${shotNo}번 (1) · ${engineLabel} · ${took}초`
        : `${shotNo}번 · ${engineLabel} · ${took}초`;
      for (let i = 1; i < data.resultDataUrls.length; i++) {
        appendResultItem(data.resultDataUrls[i], `${shotNo}번 (${i + 1}) · ${engineLabel} · ${took}초`);
      }
    } catch (err) {
      console.error(err);
      box.remove();
      item.classList.remove('pending');
      item.classList.add('failed');
      label.textContent = `${shotNo}번 · ${engineLabel} · 실패 (${shotSecs()}초)`;
      label.title = err.message;
    }
  })();
}

// ---- 4단계: 피팅샷 생성 ----
synthBtn.addEventListener('click', async () => {
  const engines = selectedEngines();
  const instrOk = hasInstructions() || noInstrCheck.checked;
  if (!(allImagesPresent() && instrOk && engines.length)) {
    setStatus(isDress()
      ? '모델·원피스 사진, 피팅 지시사항(또는 "핏 지시사항 없이"), 생성 모델 1개 이상이 필요합니다.'
      : '이미지 3장, 피팅 지시사항(또는 "핏 지시사항 없이"), 생성 모델 1개 이상이 필요합니다.');
    return;
  }
  const items = fittingItems
    .filter((item) => item.instruction.trim())
    .map((item) => ({ ...item }));
  const payload = { items, model: await fileToDataUrl(modelFile.files[0]) };
  if (noInstrCheck.checked) payload.noInstructions = true;
  if (isDress()) {
    payload.dress = await fileToDataUrl(dressFile.files[0]);
    if (includeDescState.dress) payload.dressSpec = dressSpec;
  } else {
    const [topDataUrl, bottomDataUrl] = await Promise.all([
      fileToDataUrl(topFile.files[0]), fileToDataUrl(bottomFile.files[0]),
    ]);
    Object.assign(payload, { top: topDataUrl, bottom: bottomDataUrl });
    if (includeDescState.top) payload.topSpec = topSpec;
    if (includeDescState.bottom) payload.bottomSpec = bottomSpec;
  }
  for (const engine of engines) runSynthShot(payload, engine);
  setStatus(`${engines.length}개 모델로 피팅샷 생성 중... (모델마다 1~2분 걸릴 수 있어요)`);
});

refreshButtonStates();
