// 피팅샷 v2.3 — 참조이미지(더미 목업) 방식을 폐기하고, 옷 실측 추정 → 모델 실측과 비교한
// 텍스트 피팅 지시사항 → 최종 프롬프트 주입의 3단계 흐름. 캔버스/메쉬 편집기는 없습니다.
// 각 단계 결과(옷 실측, 피팅 지시사항)를 사용자가 화면에서 직접 편집할 수 있고, 편집한
// 내용이 그대로 다음 단계로 전달됩니다.

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
// 옷 분석에 쓸 모델(한 줄 라디오). 선택된 값을 읽습니다.
function selectedAnalysisModel() {
  const checked = document.querySelector('input[name="analysisModel"]:checked');
  return checked ? checked.value : 'gemini-3.5-flash';
}
const engineChecks = document.getElementById('engineChecks');
const engineAllBtn = document.getElementById('engineAllBtn');
const noInstrCheck = document.getElementById('noInstrCheck');

// 생성 모델 목록. 기본(gemini)/gpt-image-2(OpenAI 직접) 외에는 텐센트 MPS 이미지 모델 전체.
// value는 서버 engine 키와 일치해야 합니다(synth-providers.ts TENCENT_MODELS).
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

// 모델 체크박스 렌더 (기본은 Gemini 하나만 선택).
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
// [전체선택] ↔ [전체해제] 토글.
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

// 옷 스펙은 {garment_type, description, measurements:[{label, value_cm, x1,y1,x2,y2}]} 구조로 받아,
// 위쪽에 "무슨 옷인지" 설명 + 치수 화살표가 그려진 사진을, 아래쪽에 실측 항목을 하나씩 나눠
// 보여주고 편집한 내용을 그대로 보관합니다. (x1~y2는 사진 위 측정 위치, 0~1000 정규화)
let topSpec = null;
let bottomSpec = null;
let dressSpec = null;
// 각 옷 스펙의 오버레이에 쓸 원본 사진(Image 객체). 분석 시점의 업로드 사진으로 채웁니다.
let topSpecImg = null;
let bottomSpecImg = null;
let dressSpecImg = null;

// 상의/하의 모드와 원피스 모드는 별개의 모드입니다. 원피스 모드는 옷 사진 1장(원피스)만
// 받아서 분석하고, 합성도 모델+원피스 2장으로 보냅니다.
let mode = 'separate'; // 'separate' | 'dress'
const isDress = () => mode === 'dress';

// 모델 신체 실측 ({height_cm, weight_kg, shoulder_width_cm, ...}). 편집 가능.
// lines: [{label, value_cm, x1,y1,x2,y2}] — 모델 사진 위 측정선(보여주기 전용, 편집 불가).
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

// 피팅 지시사항은 항목별({garment, category, instruction})로 받아서, 상의/하의/전체로 그룹핑해
// 화면에 뿌리고, 사용자가 항목마다 수정한 내용을 그대로 이 배열에 반영해 합성에 넘깁니다.
let fittingItems = [];

function setStatus(text) { statusEl.textContent = text; }

// 버튼을 누른 시점부터 결과가 화면에 그려질 때까지의 소요 시간. 진행 중에는 표시하지 않고,
// 끝났을 때 최종 소요 시간만 보여줍니다.
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

// ---- 모드 전환 (상의/하의 ↔ 원피스) ----
function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-separate', !isDress());
  document.body.classList.toggle('mode-dress', isDress());
  modeSeparateBtn.classList.toggle('active', !isDress());
  modeDressBtn.classList.toggle('active', isDress());
  // 모드가 바뀌면 이전 모드의 분석 결과/지시사항은 더 이상 맞지 않으므로 비웁니다.
  fittingItems = [];
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

// 현재 모드에서 옷 실측 분석이 끝났는지.
function specsReady() {
  return isDress() ? !!dressSpec : !!(topSpec && bottomSpec);
}

// 버튼 활성화 규칙:
// - [옷 분석]: 3장 다 업로드되면 활성.
// - [피팅 지시사항 생성]: 상/하의 실측이 채워지면 활성.
// - [피팅샷 생성]: 피팅 지시사항 텍스트가 있으면(그리고 3장 다 있으면) 활성.
function hasInstructions() {
  return fittingItems.some((item) => item.instruction.trim());
}

function refreshButtonStates() {
  analyzeModelBtn.disabled = !modelFile.files[0];
  analyzeBtn.disabled = !allImagesPresent();
  instructionsBtn.disabled = !(specsReady() && modelSpec);
  // 피팅샷: 이미지가 다 있고, (지시사항이 있거나 '핏 지시사항 없이'가 켜졌고), 모델이 하나 이상 선택됐을 때.
  const instrOk = hasInstructions() || (noInstrCheck && noInstrCheck.checked);
  const engineOk = engineChecks && engineChecks.querySelector('input:checked');
  synthBtn.disabled = !(allImagesPresent() && instrOk && engineOk);
  clearResultsBtn.disabled = !resultWrap.firstChild;
}

// ---- 모델 신체 실측 렌더링 (항목별 편집 가능) ----
function renderModelSpec() {
  modelSpecBox.innerHTML = '';
  modelSpecPlaceholder.style.display = modelSpec ? 'none' : '';
  if (!modelSpec) return;

  // 모델 사진 위 측정선(키/어깨너비/팔길이 등) — 보여주기 전용. 클릭하면 크게 볼 수 있습니다.
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

// ---- 옷 사진 위 치수 화살표 오버레이 ----
// 작업지시서 도식처럼, 각 실측 항목의 측정 위치(x1,y1→x2,y2, 0~1000 정규화)에 양쪽 화살표
// 선 + "라벨 수치cm" 표기를 원본 사진 위에 그립니다. 수치를 편집하면 라벨도 다시 그려집니다.
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

// 지정한 폭으로 (사진 + 화살표 + 라벨)을 캔버스에 그려서 반환합니다.
// items: [{label, value_cm, x1, y1, x2, y2}] (좌표는 0~1000 정규화)
// 라벨은 선을 다 그린 뒤 두 번째 패스에서 배치하는데, 이미 놓인 라벨과 겹치면 선을 따라
// 앞뒤로, 그리고 선의 수직 방향으로 밀어서 빈 자리를 찾습니다(작업지시서처럼 겹침 없이).
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

  // 1패스: 화살표 선
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

  // 2패스: 라벨 (겹치지 않는 자리 탐색)
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
    // 선의 수직 방향 단위벡터 (라벨을 선 옆으로 밀 때 사용)
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

    // 선에서 밀려난 라벨은 얇은 지시선으로 원래 측정선과 이어줍니다.
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

  // 오른쪽 아래에 단위 표기 (라벨의 숫자는 모두 cm)
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

function renderSpecOverlayCanvas(img, spec, width) {
  return renderOverlayCanvas(img, spec.measurements, width);
}

// 옷 종류/설명을 최종 프롬프트의 GARMENT DESCRIPTION에 넣을지 여부(벌별 체크박스).
// 체크 안 하면(기본) 그 옷의 설명은 프롬프트에 아무것도 넣지 않습니다.
const includeDescState = { top: false, bottom: false, dress: false };

// 옷 한 벌을 "설명 + 치수 화살표 사진(위) + 실측 항목(아래)" 형태로 그립니다.
// 값을 고치면 spec 객체에 바로 반영되고 오버레이 라벨도 다시 그려집니다.
function renderSpecBox(container, spec, img, title, slotKey) {
  container.innerHTML = '';
  if (!spec) return;

  const groupTitle = document.createElement('div');
  groupTitle.className = 'instrGroupTitle';
  groupTitle.textContent = title;
  container.appendChild(groupTitle);

  // garment_type + description은 아래 체크박스를 켠 경우에만 최종 합성 프롬프트의
  // GARMENT DESCRIPTION(TEXT_GUIDE)로 "종류 — 설명" 형태로 들어갑니다.
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

  // 치수 화살표 오버레이: 미리보기는 패널 폭에 맞게, 클릭하면 고해상도(1000px)로 팝업.
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

  (spec.measurements || []).forEach((m) => {
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
    value.addEventListener('input', () => {
      m.value_cm = parseFloat(value.value);
      redrawOverlay();
    });
    const unit = document.createElement('span');
    unit.className = 'specUnit';
    unit.textContent = 'cm';
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(unit);
    container.appendChild(row);
  });
}

function renderSpecs() {
  const any = isDress() ? dressSpec : (topSpec || bottomSpec);
  specPlaceholder.style.display = any ? 'none' : '';
  renderSpecBox(topSpecBox, topSpec, topSpecImg, '상의', 'top');
  renderSpecBox(bottomSpecBox, bottomSpec, bottomSpecImg, '하의', 'bottom');
  renderSpecBox(dressSpecBox, dressSpec, dressSpecImg, '원피스', 'dress');
}

// 오버레이용 사진 로드. 업로드 파일에서 blob URL로 직접 읽습니다(거대한 data URL을
// <img>에 물리면 브라우저가 거부하는 경우가 있어서). 브라우저가 못 여는 형식(HEIC 등)이면
// null을 돌려주고, 그때는 화살표 없이 수치만 보여줍니다 — 분석 자체는 실패시키지 않습니다.
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 브라우저에서 열 수 없습니다 (지원하지 않는 형식일 수 있음)'));
    img.src = src;
  });
}

// 상의 / 하의 / 전체로 그룹핑하고, 각 항목(핏·기장·소매 등)마다 편집 가능한 칸을 그립니다.
const INSTRUCTION_GROUPS = [
  { key: 'top', label: '상의' },
  { key: 'bottom', label: '하의' },
  { key: 'dress', label: '원피스' },
  { key: 'overall', label: '전체 / 레이어링' },
];

// 지시사항 칸을 내용 길이에 맞춥니다: 2줄짜리는 2줄만, 길면 최대 5줄까지 늘리고
// 그 이상은 스크롤. (한 줄 = 12px × 1.5, 상하 패딩 20px)
const INSTR_LINE_PX = 18;
const INSTR_PAD_PX = 22;
function autoSizeInstr(textarea) {
  // 화면에 붙기 전에는 scrollHeight가 0이라 높이를 잴 수 없습니다. 붙은 뒤에만 조절합니다.
  if (!textarea.isConnected) return;
  const minPx = INSTR_LINE_PX + INSTR_PAD_PX;
  const maxPx = INSTR_LINE_PX * 5 + INSTR_PAD_PX;
  textarea.style.height = 'auto';
  const needed = textarea.scrollHeight;
  textarea.style.height = `${Math.min(Math.max(needed, minPx), maxPx)}px`;
  textarea.style.overflowY = needed > maxPx ? 'auto' : 'hidden';
}

function renderFittingItems() {
  instructionsWrap.innerHTML = '';
  instructionsPlaceholder.style.display = fittingItems.length ? 'none' : '';

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

  // 모두 화면에 붙은 뒤에야 실제 폭/줄 수가 정해지므로, 그 시점에 각 칸의 높이를 내용에 맞춥니다.
  for (const textarea of instructionsWrap.querySelectorAll('.instrText')) autoSizeInstr(textarea);
}

// ---- 1단계: 모델 체형 분석 ----
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

// ---- 2단계: 옷 실측 분석 ----
analyzeBtn.addEventListener('click', async () => {
  if (!allImagesPresent()) { setStatus('모델/상의/하의 이미지를 모두 선택하세요.'); return; }
  analyzeBtn.disabled = true;
  setStatus('옷 사진에서 실측(cm)과 측정 위치를 추정하는 중... (상/하의 병렬)');

  // 상의/하의를 각각 따로 요청해서 소요 시간을 따로 재고, 먼저 끝난 쪽부터 화면에 그립니다.
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
    setStatus('옷 실측 분석 완료. 사진 위 화살표로 측정 위치를 확인하고, 필요하면 수치를 고친 뒤 [피팅 지시사항 생성]을 누르세요.');
  }
  refreshButtonStates();
});

// ---- 3단계: 핏/기장 지시사항 생성 ----
instructionsBtn.addEventListener('click', async () => {
  if (!(specsReady() && modelSpec)) { setStatus('먼저 모델 체형 분석과 옷 실측 분석을 완료하세요.'); return; }
  instructionsBtn.disabled = true;
  setStatus('옷 실측과 모델 실측을 비교해 피팅 지시사항을 만드는 중...');
  const timer = startTimer(instrElapsed, '지시사항');
  try {
    // 옷 이미지는 정성적 맥락(드레이프/실루엣)용으로만 함께 보냅니다(수치는 텍스트가 우선).
    const payload = { modelSpec };
    if (isDress()) {
      payload.dress = await fileToDataUrl(dressFile.files[0]);
      payload.dressSpec = dressSpec;
    } else {
      const [topDataUrl, bottomDataUrl] = await Promise.all([
        fileToDataUrl(topFile.files[0]), fileToDataUrl(bottomFile.files[0]),
      ]);
      Object.assign(payload, { top: topDataUrl, bottom: bottomDataUrl, topSpec, bottomSpec });
    }
    const res = await fetch('/api/v23/fitting-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    fittingItems = data.items || [];
    renderFittingItems();
    timer.stop(true);
    setStatus('피팅 지시사항 생성 완료. 항목별로 직접 수정한 뒤 [피팅샷 생성]을 누르세요.');
  } catch (err) {
    console.error(err);
    timer.stop(false);
    setStatus('실패: ' + err.message);
  } finally {
    refreshButtonStates();
  }
});

// ---- 결과 그리드 헬퍼 (v2.2와 동일 패턴) ----
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
// [피팅샷 생성]을 누른 순서대로 1번, 2번, ... 번호를 붙입니다(비동기라 끝나는 순서가
// 뒤바뀌어도 카드 자리와 번호는 누른 순서 그대로 유지됩니다).
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

// [초기화]: 지금까지 만든 결과 카드를 모두 지우고 번호도 1번부터 다시 시작합니다.
// (생성 중인 카드가 있으면 그것도 함께 사라지고, 그 요청의 결과는 화면에 그려지지 않습니다.
// 이미 저장된 output 폴더의 PNG 파일은 지우지 않습니다.)
clearResultsBtn.addEventListener('click', () => {
  resultWrap.innerHTML = '';
  synthCount = 0;
  setStatus('합성 결과를 초기화했습니다.');
  refreshButtonStates();
});

// 한 엔진에 대해 피팅샷 한 장을 생성합니다(비동기, 다른 엔진과 병렬로 진행).
// basePayload는 이미지/스펙/지시사항 등 공통 부분이고, 여기에 engine만 얹어 보냅니다.
function runSynthShot(basePayload, engine) {
  const engineLabel = ENGINE_LABELS[engine] || engine;
  const shotNo = ++synthCount;
  const shotStart = performance.now();
  const shotSecs = () => ((performance.now() - shotStart) / 1000).toFixed(1);
  const { item, box, label } = appendPendingResultItem(`${shotNo}번 · ${engineLabel} · 생성 중...`);

  (async () => {
    try {
      const res = await fetch('/api/v23/synthesize', {
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

// ---- 4단계: 피팅샷 생성 (선택된 모델마다 한 장씩, 여러 모델 동시 진행) ----
synthBtn.addEventListener('click', async () => {
  const engines = selectedEngines();
  const instrOk = hasInstructions() || noInstrCheck.checked;
  if (!(allImagesPresent() && instrOk && engines.length)) {
    setStatus(isDress()
      ? '모델·원피스 사진, 피팅 지시사항(또는 "핏 지시사항 없이"), 생성 모델 1개 이상이 필요합니다.'
      : '이미지 3장, 피팅 지시사항(또는 "핏 지시사항 없이"), 생성 모델 1개 이상이 필요합니다.');
    return;
  }
  // 지금 화면에서 편집된 상태 그대로(빈 항목은 제외) 넘깁니다.
  const items = fittingItems
    .filter((item) => item.instruction.trim())
    .map((item) => ({ ...item }));
  // 원피스 모드는 모델+원피스 2장, 상하의 모드는 모델+상의+하의 3장을 보냅니다.
  // 옷 스펙(garment_type/description)은 [포함하기] 체크박스를 켠 옷만 함께 보내
  // TEXT_GUIDE에 쓰입니다. 체크 안 한 옷의 설명 슬롯은 비워 둡니다.
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
  // 선택한 모델마다 한 장씩(병렬로) 생성.
  for (const engine of engines) runSynthShot(payload, engine);
  setStatus(`${engines.length}개 모델로 피팅샷 생성 중... (모델마다 1~2분 걸릴 수 있어요)`);
});

refreshButtonStates();
