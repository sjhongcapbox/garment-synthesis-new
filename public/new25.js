// 피팅샷 v2.5 — v2.4의 "코드가 착지점 계산 → LLM은 문장화만" 구조를 유지하면서 구성을 확장:
//  · 상의 최대 3겹 / 하의 2겹 / 원피스·세트 3겹 (업로드 순서 = 착장 순서, 첫 장이 가장 안쪽)
//  · 액세서리 2개 / 신발 1개 — 실측 없이 "무슨 아이템인지" 이름만 인식해 착장
//  · 코드가 겹침 관계(어느 밑단이 더 아래라 무엇이 가려지는지)까지 판정해 FIT MAP에 포함
// 모델/옷 실측 분석 API는 v2.3(/api/v23/*)을 재사용하고, 분류·핏·합성만 /api/v25/*를 씁니다.

const statusEl = document.getElementById('status');
const uploadArea = document.getElementById('uploadArea');
const imageCountHint = document.getElementById('imageCountHint');
const analyzeBtn = document.getElementById('analyzeBtn');
const instructionsBtn = document.getElementById('instructionsBtn');
const synthBtn = document.getElementById('synthBtn');
const specGrid = document.getElementById('specGrid');
const accGrid = document.getElementById('accGrid');
const shoesGrid = document.getElementById('shoesGrid');
const garmentSection = document.getElementById('garmentSection');
const accSection = document.getElementById('accSection');
const shoesSection = document.getElementById('shoesSection');
const specPlaceholder = document.getElementById('specPlaceholder');
const analyzeModelBtn = document.getElementById('analyzeModelBtn');
const modelSpecBox = document.getElementById('modelSpecBox');
const modelSpecPlaceholder = document.getElementById('modelSpecPlaceholder');
const modeSeparateBtn = document.getElementById('modeSeparateBtn');
const modeDressBtn = document.getElementById('modeDressBtn');
const clearResultsBtn = document.getElementById('clearResultsBtn');
const fitMapWrap = document.getElementById('fitMapWrap');
const engineChecks = document.getElementById('engineChecks');
const engineAllBtn = document.getElementById('engineAllBtn');
const noInstrCheck = document.getElementById('noInstrCheck');
const showArrowsCheck = document.getElementById('showArrowsCheck');
const modelElapsed = document.getElementById('modelElapsed');
const garmentElapsed = document.getElementById('garmentElapsed');
const instrElapsed = document.getElementById('instrElapsed');
const instructionsWrap = document.getElementById('instructionsWrap');
const instructionsPlaceholder = document.getElementById('instructionsPlaceholder');
const resultWrap = document.getElementById('resultWrap');
const modalOverlay = document.getElementById('modalOverlay');
const modalImg = document.getElementById('modalImg');

// v2.5 기본 분석/핏 모델은 GPT-5.6 Terra (라디오가 항상 선택돼 있으므로 아래는 안전망).
const DEFAULT_ANALYSIS_MODEL = 'gpt-5.6-terra';
function selectedAnalysisModel() {
  const c = document.querySelector('input[name="analysisModel"]:checked');
  return c ? c.value : DEFAULT_ANALYSIS_MODEL;
}
function selectedFittingModel() {
  const c = document.querySelector('input[name="fittingModel"]:checked');
  return c ? c.value : DEFAULT_ANALYSIS_MODEL;
}

// v2.5 생성 엔진은 Gemini / GPT Image-2 두 계열만 씁니다(이미지 장수가 많아져
// 다장수 입력이 확실한 엔진만 남김). 기본값은 GPT Image-2 Medium.
const ENGINES = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'gpt-image-2-high', label: 'GPT Image-2 (High)' },
  { value: 'gpt-image-2-medium', label: 'GPT Image-2 (Medium)' },
];
const ENGINE_LABELS = Object.fromEntries(ENGINES.map((e) => [e.value, e.label]));
const DEFAULT_ENGINE = 'gpt-image-2-medium';

for (const eng of ENGINES) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = eng.value;
  cb.checked = eng.value === DEFAULT_ENGINE;
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

// ---- 업로드 슬롯 정의 ----
// max = 최대 장수. 옷 슬롯(top/bottom/dress)은 업로드 순서가 곧 겹 순서입니다.
const SLOTS = [
  { key: 'model', label: '모델 사진', max: 1, modes: ['separate', 'dress'], hint: '전신 1장' },
  { key: 'top', label: '상의', max: 3, modes: ['separate'], hint: '안→밖 순서 (예: 셔츠→코트)' },
  { key: 'bottom', label: '하의', max: 2, modes: ['separate'], hint: '안→밖 순서' },
  { key: 'dress', label: '원피스 / 세트', max: 3, modes: ['dress'], hint: '안→밖 순서 (예: 원피스→자켓)' },
  { key: 'acc', label: '액세서리', max: 2, modes: ['separate', 'dress'], hint: '모자·목도리·선글라스·가방 등. 없으면 미착용' },
  { key: 'shoes', label: '신발', max: 1, modes: ['separate', 'dress'], hint: '없으면 AI가 자동 매칭' },
];
const GARMENT_SLOTS = ['top', 'bottom', 'dress'];
const ITEM_SLOTS = ['acc', 'shoes'];
const SLOT_TITLE = { top: '상의', bottom: '하의', dress: '원피스/세트' };

const files = { model: [], top: [], bottom: [], dress: [], acc: [], shoes: [] };
// 옷 슬롯별 분석 결과: [{ spec, img, include }] — 배열 index가 곧 겹 순서
const specs = { top: [], bottom: [], dress: [] };
// 액세서리/신발도 옷과 같은 형태({spec, img, include})로 담아 동일한 spec box로 그립니다.
// spec.garment_type = 아이템 이름, spec.measurements = 종류별 실측(가방 가로/스트랩드롭 등).
const wornItems = { acc: [], shoes: [] };

// 착용 방법 선택지. 같은 가방도 어깨/크로스/팔/손/백팩에 따라 그림이 완전히 달라지므로
// AI 제안값을 기본으로 두되 사용자가 직접 고를 수 있게 합니다.
const WEAR_STYLES = {
  bag: ['어깨에 메기', '크로스로 메기', '팔(팔꿈치)에 걸기', '손에 들기', '등에 메기(백팩)'],
  hat: ['머리에 착용', '살짝 뒤로 젖혀 쓰기'],
  scarf: ['목에 두르기', '목에 한 번 감기', '어깨에 걸치기', '앞으로 길게 늘어뜨리기'],
  glasses: ['얼굴에 착용', '머리 위로 올리기'],
  belt: ['허리에 착용', '골반에 걸치기'],
  gloves: ['양손에 착용', '한 손에 들기'],
  generic: ['자연스럽게 착용'],
};
// 최종 프롬프트의 GARMENT DESCRIPTION에 항목별로 들어가는 외형 설명 칸.
const DESC_FIELDS = [
  { key: 'design', label: '디자인', placeholder: '실루엣·형태·넥라인·여밈·소매 형태' },
  { key: 'material_color', label: '소재 및 색상', placeholder: '소재·질감·광택·두께·색상, 그리고 원단이 뻣뻣한지 흐르는지' },
  { key: 'details', label: '디테일', placeholder: '단추·포켓·스티치·커프스·플리츠·트임·프린트·자수' },
];

let wearStyleSeq = 0; // datalist id 중복 방지용
function wearStyleOptions(name, wornOn) {
  const s = `${name || ''} ${wornOn || ''}`;
  if (/가방|백|토트|숄더|크로스|클러치|백팩|파우치/.test(s)) return WEAR_STYLES.bag;
  if (/모자|캡|햇|비니|베레/.test(s)) return WEAR_STYLES.hat;
  if (/스카프|머플러|숄|목도리/.test(s)) return WEAR_STYLES.scarf;
  if (/선글라스|안경/.test(s)) return WEAR_STYLES.glasses;
  if (/벨트/.test(s)) return WEAR_STYLES.belt;
  if (/장갑|글러브/.test(s)) return WEAR_STYLES.gloves;
  return WEAR_STYLES.generic;
}

let mode = 'separate';
const isDress = () => mode === 'dress';
const activeSlots = () => SLOTS.filter((s) => s.modes.includes(mode));
const activeGarmentSlots = () => (isDress() ? ['dress'] : ['top', 'bottom']);

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
let lastFitMap = null;

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

async function parseJsonOrThrow(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`서버가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`); }
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 최대 9장을 한 요청에 보내므로, 업로드 전에 긴 변 2048px로 줄여 본문 크기와
// 업로드/다운로드 타임아웃을 줄입니다. 브라우저가 못 여는 형식이면 원본을 그대로 보냅니다.
const MAX_UPLOAD_SIDE = 2048;
async function toUploadDataUrl(file) {
  const img = await loadImageFromFile(file);
  if (!img) return fileToDataUrl(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_UPLOAD_SIDE) return fileToDataUrl(file);
  const scale = MAX_UPLOAD_SIDE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// 썸네일용 objectURL은 파일당 한 번만 만들어 재사용합니다(재렌더마다 새로 만들면 누수).
const thumbUrls = new WeakMap();
function thumbUrl(file) {
  if (!thumbUrls.has(file)) thumbUrls.set(file, URL.createObjectURL(file));
  return thumbUrls.get(file);
}

// ---- 업로드 영역 렌더 ----
function totalImageCount() {
  return activeSlots().reduce((n, s) => n + files[s.key].length, 0);
}

function renderUploadArea() {
  uploadArea.innerHTML = '';
  for (const slot of activeSlots()) {
    const list = files[slot.key];
    const box = document.createElement('div');
    box.className = 'slot';

    const head = document.createElement('div');
    head.className = 'slotHead';
    head.textContent = slot.label;
    const count = document.createElement('span');
    count.className = 'slotCount';
    count.textContent = `${list.length}/${slot.max}`;
    head.appendChild(count);
    box.appendChild(head);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (slot.max > 1) input.multiple = true;
    input.disabled = list.length >= slot.max;
    input.addEventListener('change', (e) => {
      const picked = [...e.target.files];
      const room = slot.max - list.length;
      if (picked.length > room) setStatus(`${slot.label}은(는) 최대 ${slot.max}장까지입니다. 앞의 ${room}장만 추가했습니다.`);
      list.push(...picked.slice(0, room));
      onUploadChanged();
    });
    box.appendChild(input);

    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    list.forEach((file, i) => {
      const item = document.createElement('div');
      item.className = 'thumbItem';
      const img = document.createElement('img');
      img.src = thumbUrl(file);
      img.addEventListener('click', () => openModal(img.src));
      item.appendChild(img);
      if (slot.max > 1) {
        const no = document.createElement('span');
        no.className = 'layerNo';
        no.textContent = `L${i + 1}`;
        no.title = i === 0 ? '가장 안쪽' : i === list.length - 1 ? '가장 바깥' : '중간';
        item.appendChild(no);
      }
      // 같은 자리에 사진만 갈아끼우기. 지웠다 다시 올리면 맨 뒤로 가서 겹 순서(L1/L2/L3)가
      // 바뀌므로, 교체는 인덱스를 유지한 채 그 자리의 분석 결과만 비웁니다.
      const swap = document.createElement('label');
      swap.className = 'swap';
      swap.title = '이 자리의 사진만 교체';
      swap.textContent = '교체';
      const swapInput = document.createElement('input');
      swapInput.type = 'file';
      swapInput.accept = 'image/*';
      swapInput.addEventListener('change', (e) => {
        const picked = e.target.files[0];
        if (!picked) return;
        list[i] = picked;
        if (specs[slot.key]) specs[slot.key][i] = null;
        if (wornItems[slot.key]) wornItems[slot.key][i] = null;
        onUploadChanged();
        setStatus('사진을 교체했습니다. 해당 항목의 [분석하기]를 누르세요.');
      });
      swap.appendChild(swapInput);
      item.appendChild(swap);

      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.textContent = '×';
      del.title = '삭제';
      del.addEventListener('click', () => {
        list.splice(i, 1);
        // 사진과 분석 결과는 같은 인덱스로 짝지어 있으므로, 슬롯 전체를 비우지 말고 그 자리만
        // 같이 빼냅니다. 그래야 남은 항목에 손으로 고쳐 둔 실측·설명이 살아남습니다.
        if (specs[slot.key]) specs[slot.key].splice(i, 1);
        if (wornItems[slot.key]) wornItems[slot.key].splice(i, 1);
        onUploadChanged();
      });
      item.appendChild(del);
      thumbs.appendChild(item);
    });
    box.appendChild(thumbs);

    if (slot.hint) {
      const hint = document.createElement('div');
      hint.className = 'slotHint';
      hint.textContent = slot.hint;
      box.appendChild(hint);
    }
    uploadArea.appendChild(box);
  }
  imageCountHint.textContent = `총 ${totalImageCount()}장 업로드됨`;
}

function onUploadChanged() {
  renderUploadArea();
  renderSpecs();

  refreshButtonStates();
}

function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-separate', !isDress());
  document.body.classList.toggle('mode-dress', isDress());
  modeSeparateBtn.classList.toggle('active', !isDress());
  modeDressBtn.classList.toggle('active', isDress());
  // 모드가 바뀌면 이전 모드의 분석 결과/지시사항은 더 이상 맞지 않습니다.
  specs.top = []; specs.bottom = []; specs.dress = [];
  fittingItems = [];
  lastFitMap = null;
  renderFitMap();
  renderFittingItems();
  onUploadChanged();
}
modeSeparateBtn.addEventListener('click', () => setMode('separate'));
modeDressBtn.addEventListener('click', () => setMode('dress'));

modalOverlay.addEventListener('click', () => modalOverlay.classList.remove('show'));
function openModal(src) {
  if (!src) return;
  modalImg.src = src;
  modalOverlay.classList.add('show');
}

// 합성에 필요한 최소 구성: 모델 1장 + (상하의 모드면 상의·하의 각 1장 이상 / 원피스 모드면 1장 이상)
function requiredImagesPresent() {
  if (!files.model.length) return false;
  return isDress() ? files.dress.length > 0 : (files.top.length > 0 && files.bottom.length > 0);
}
function specsReady() {
  // 항목별 분석이 가능해지면서 배열이 듬성듬성할 수 있으므로 길이만 보지 않고 각 자리를 확인합니다.
  return activeGarmentSlots().every((k) =>
    files[k].length > 0 && files[k].every((_, i) => specs[k][i] && specs[k][i].spec));
}
function hasInstructions() {
  return fittingItems.some((item) => item.instruction.trim());
}

function refreshButtonStates() {
  analyzeModelBtn.disabled = !files.model.length;
  analyzeBtn.disabled = !requiredImagesPresent();
  instructionsBtn.disabled = !(specsReady() && modelSpec);
  const instrOk = hasInstructions() || (noInstrCheck && noInstrCheck.checked);
  const engineOk = engineChecks && engineChecks.querySelector('input:checked');
  synthBtn.disabled = !(requiredImagesPresent() && instrOk && engineOk);
  clearResultsBtn.disabled = !resultWrap.firstChild;
}

// ---- 모델 신체 실측 ----
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
    row.appendChild(label); row.appendChild(value); row.appendChild(unit);
    rows.appendChild(row);
  }
}

// ---- 치수 화살표 오버레이 (v2.4와 동일) ----
const OVERLAY_COLORS = ['#e74c3c', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#c0392b', '#2c3e50'];

function drawArrowhead(ctx, x, y, angle, size, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-size, -size * 0.45); ctx.lineTo(-size, size * 0.45); ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.restore();
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

  const drawable = (items || []).filter((m) => m.x1 != null && m.y1 != null && m.x2 != null && m.y2 != null);
  const lines = drawable.map((m, i) => {
    const color = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
    const x1 = (m.x1 / 1000) * canvas.width, y1 = (m.y1 / 1000) * canvas.height;
    const x2 = (m.x2 / 1000) * canvas.width, y2 = (m.y2 / 1000) * canvas.height;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, width * 0.004);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
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
    let best = null, fallback = null;
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
        if (!placed.some((p) => rectsOverlap(p, rect))) { best = { rect, cx, cy, ax, ay, off }; break outer; }
      }
    }
    const pick = best || fallback;
    if (!pick) continue;
    placed.push(pick.rect);
    if (pick.off !== 0) {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pick.ax, pick.ay); ctx.lineTo(pick.cx, pick.cy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(pick.rect.x, pick.rect.y, pick.rect.w, pick.rect.h);
    ctx.strokeStyle = color; ctx.lineWidth = 1;
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
function arrowsEnabled() { return !showArrowsCheck || showArrowsCheck.checked; }
function renderSpecOverlayCanvas(img, spec, width) {
  return renderOverlayCanvas(img, arrowsEnabled() ? spec.measurements : [], width);
}
if (showArrowsCheck) showArrowsCheck.addEventListener('change', renderSpecs);

// ---- 비율 잠금 ----
function measurePixelLen(m, img) {
  if (!img) return null;
  if (m.x1 == null || m.y1 == null || m.x2 == null || m.y2 == null) return null;
  const dx = ((m.x2 - m.x1) / 1000) * img.naturalWidth;
  const dy = ((m.y2 - m.y1) / 1000) * img.naturalHeight;
  const len = Math.hypot(dx, dy);
  return len > 0.5 ? len : null;
}
function propagateLocked(spec, img, anchor, rowRefs) {
  const anchorLen = measurePixelLen(anchor, img);
  const anchorVal = parseFloat(anchor.value_cm);
  if (!anchorLen || !Number.isFinite(anchorVal)) return;
  const k = anchorVal / anchorLen;
  for (const ref of rowRefs) {
    if (ref.m === anchor) continue;
    if (!ref.m._locked || !ref.hasLine) continue;
    const v = Math.round(k * ref.len * 2) / 2;
    ref.m.value_cm = v;
    ref.input.value = v;
    ref.m._ai = false;
    if (ref.badge) ref.badge.classList.add('hidden');
  }
}

// 아직 분석하지 않은 사진의 자리. 사진을 새로 올리면 곧바로 여기가 생기고, 이 항목만
// 분석할 수 있습니다. (예전에는 분석 결과가 있는 것만 그려서, 사진을 다시 올리면 그 칸이
// 통째로 사라져 [재분석]을 누를 대상 자체가 없었습니다.)
function renderPendingBox(container, file, title, kind, ref) {
  container.innerHTML = '';
  container.classList.add('specBoxPending');

  const head = document.createElement('div');
  head.className = 'instrGroupTitle specBoxHead';
  const titleText = document.createElement('span');
  titleText.textContent = title;
  head.appendChild(titleText);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reanalyzeBtn';
  btn.textContent = '분석하기';
  btn.title = '이 사진만 분석합니다 (다른 항목은 그대로)';
  btn.addEventListener('click', () => reanalyzeOne(kind, ref.key, ref.index, btn));
  head.appendChild(btn);
  container.appendChild(head);

  const img = document.createElement('img');
  img.className = 'pendingThumb';
  img.src = thumbUrl(file);
  img.addEventListener('click', () => openModal(img.src));
  container.appendChild(img);

  const note = document.createElement('div');
  note.className = 'pendingNote';
  note.textContent = '아직 분석하지 않은 사진입니다. [분석하기]를 누르거나 위의 [옷 분석]을 누르세요.';
  container.appendChild(note);
}

// 옷 한 겹 / 액세서리 / 신발을 "설명 + (선택)화살표 사진 + 실측 항목(비율 잠금)"으로 그립니다.
// kind: 'garment' | 'accessory' | 'shoes' — 액세서리·신발은 착용 방법 선택이 추가됩니다.
function renderSpecBox(container, entry, title, kind = 'garment', ref = null) {
  const spec = entry.spec;
  const img = entry.img;
  container.innerHTML = '';
  container.classList.remove('specBoxPending');
  if (!spec) return;
  const isWorn = kind !== 'garment';

  const groupTitle = document.createElement('div');
  groupTitle.className = 'instrGroupTitle specBoxHead';
  const caret = document.createElement('span');
  caret.className = 'foldCaret';
  const titleText = document.createElement('span');
  titleText.textContent = title;
  groupTitle.appendChild(caret);
  groupTitle.appendChild(titleText);
  // 접었을 때 제목만 남으면 어느 옷인지 알기 어려워, 이름 + 핵심 실측을 한 줄로 요약합니다.
  const summary = document.createElement('span');
  summary.className = 'specSummary';
  summary.textContent = [
    spec.garment_type,
    ...(spec.measurements || []).slice(0, 3).map((m) => `${m.label} ${m.value_cm}`),
  ].filter(Boolean).join(' · ');
  groupTitle.appendChild(summary);
  // 사진 한 장만 교체했을 때 이 항목만 다시 태우는 버튼. 다른 항목의 수정값은 보존됩니다.
  if (ref) {
    const reBtn = document.createElement('button');
    reBtn.type = 'button';
    reBtn.className = 'reanalyzeBtn';
    reBtn.textContent = '재분석';
    reBtn.title = '이 항목만 다시 분석합니다 (다른 항목은 그대로)';
    reBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 제목 클릭은 접기 토글이므로 재분석 클릭이 접기를 부르지 않게
      reanalyzeOne(kind, ref.key, ref.index, reBtn);
    });
    groupTitle.appendChild(reBtn);
  }
  container.appendChild(groupTitle);

  // 접기 상태는 entry에 저장합니다. renderSpecs가 카드를 다시 그려도 유지되도록.
  const applyFold = () => {
    const folded = !!entry._folded;
    container.classList.toggle('specBoxFolded', folded);
    caret.textContent = folded ? '▸' : '▾';
    summary.style.display = folded ? '' : 'none';
  };
  groupTitle.addEventListener('click', () => {
    entry._folded = !entry._folded;
    applyFold();
  });

  // 사진(왼쪽) / 설명·실측(오른쪽) 2단. 세로로 쌓으면 카드 하나가 화면 한 장을 넘겨
  // 아이템 간 비교가 불가능했습니다. 좁은 화면에서는 CSS가 다시 1단으로 접습니다.
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'specBody';
  const colLeft = document.createElement('div');
  colLeft.className = 'specColLeft';
  const colRight = document.createElement('div');
  colRight.className = 'specColRight';
  bodyWrap.appendChild(colLeft);
  bodyWrap.appendChild(colRight);
  container.appendChild(bodyWrap);

  const includeWrap = document.createElement('label');
  includeWrap.className = 'descInclude';
  const includeCheck = document.createElement('input');
  includeCheck.type = 'checkbox';
  includeCheck.checked = !!entry.include;
  includeCheck.addEventListener('change', () => { entry.include = includeCheck.checked; });
  includeWrap.appendChild(includeCheck);
  includeWrap.appendChild(document.createTextNode(isWorn ? ' 설명을 최종 프롬프트에 포함하기' : ' 옷 종류/설명을 최종 프롬프트에 포함하기'));
  colRight.appendChild(includeWrap);

  const typeWrap = document.createElement('div');
  typeWrap.className = 'specTypeRow';
  const typeLabel = document.createElement('div');
  typeLabel.className = 'specLabel';
  typeLabel.textContent = isWorn ? '아이템' : '옷 종류';
  const typeInput = document.createElement('input');
  typeInput.type = 'text';
  typeInput.className = 'specTypeInput';
  typeInput.value = spec.garment_type || '';
  typeInput.addEventListener('input', () => { spec.garment_type = typeInput.value; });
  typeWrap.appendChild(typeLabel); typeWrap.appendChild(typeInput);
  colRight.appendChild(typeWrap);

  // 착용 방법: 같은 가방도 어깨/크로스/팔/손/백팩에 따라 결과가 완전히 달라지므로,
  // AI 제안값을 기본 선택으로 두고 사용자가 직접 바꿀 수 있게 합니다(계산에도 반영됨).
  if (isWorn) {
    const styleRow = document.createElement('div');
    styleRow.className = 'wearStyleRow';
    const styleLabel = document.createElement('div');
    styleLabel.className = 'specLabel';
    styleLabel.textContent = '착용 방법';
    // datalist로 프리셋을 제안하되, 목록에 없는 방식도 자유롭게 직접 입력할 수 있게 합니다
    // (예: "손목에 걸어 늘어뜨리기", "가방을 앞으로 메기" 등).
    const listId = `wearStyle_${++wearStyleSeq}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wearStyleInput';
    input.setAttribute('list', listId);
    input.placeholder = '예: 목에 한 번 감고 양끝을 앞으로 늘어뜨리기';
    const options = wearStyleOptions(spec.garment_type, entry.worn_on);
    if (!entry.wear_style) entry.wear_style = options[0];
    input.value = entry.wear_style || '';
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      datalist.appendChild(o);
    }

    // 입력창만 두면 "고정된 값"처럼 보여 직접 입력이 가능하다는 걸 알기 어렵습니다.
    // 안내 문구 + 클릭 가능한 프리셋 칩을 함께 두어 두 방식 모두 눈에 보이게 합니다.
    const field = document.createElement('div');
    field.className = 'wearStyleField';
    const hint = document.createElement('div');
    hint.className = 'wearStyleHint';
    hint.textContent = '자유롭게 직접 입력하세요. 아래는 예시입니다(클릭하면 입력됨).';
    const chips = document.createElement('div');
    chips.className = 'wearStyleChips';
    const syncChips = () => {
      for (const c of chips.children) c.classList.toggle('on', c.dataset.value === input.value);
    };
    for (const opt of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wearStyleChip';
      chip.dataset.value = opt;
      chip.textContent = opt;
      chip.addEventListener('click', () => {
        input.value = opt;
        entry.wear_style = opt;
        syncChips();
      });
      chips.appendChild(chip);
    }
    input.addEventListener('input', () => { entry.wear_style = input.value; syncChips(); });
    syncChips();

    field.appendChild(input);
    field.appendChild(hint);
    field.appendChild(chips);
    field.appendChild(datalist);
    styleRow.appendChild(styleLabel);
    styleRow.appendChild(field);
    colRight.appendChild(styleRow);
  }

  // 외형은 디자인 / 소재·색상 / 디테일 세 칸으로 나눠 받습니다. 한 문단으로 뭉치면 이미지
  // 모델이 뒤쪽을 흘리고, 셀러도 일부만 고치기 어렵습니다. '핏' 칸이 없는 건 의도적입니다 —
  // 핏·기장은 FIT MAP이 유일한 출처라서 여기에 또 쓰면 서로 충돌합니다.
  const desc = document.createElement('div');
  desc.className = 'specDesc';
  const descLabel = document.createElement('div');
  descLabel.className = 'specSubLabel';
  descLabel.textContent = `${isWorn ? '아이템' : '옷'} 설명 (위 체크박스를 켜면 GARMENT DESCRIPTION으로 들어감 · 핏/기장은 아래 실측이 담당)`;
  desc.appendChild(descLabel);
  for (const f of DESC_FIELDS) {
    const row = document.createElement('div');
    row.className = 'descField';
    const lab = document.createElement('div');
    lab.className = 'descFieldLabel';
    lab.textContent = f.label;
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.rows = 2;
    ta.placeholder = f.placeholder;
    ta.value = spec[f.key] || '';
    ta.addEventListener('input', () => { spec[f.key] = ta.value; autoSizeDesc(ta); });
    row.appendChild(lab);
    row.appendChild(ta);
    desc.appendChild(row);
  }
  colRight.appendChild(desc);

  let overlay = null;
  const redrawOverlay = () => {
    if (!img || !overlay) return;
    const drawn = renderSpecOverlayCanvas(img, spec, 700);
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
    colLeft.appendChild(overlay);
    redrawOverlay();
  }

  const rowRefs = [];
  const measures = spec.measurements || [];
  const master = document.createElement('div');
  master.className = 'specMasterLock';
  const masterBtn = document.createElement('button');
  masterBtn.type = 'button';
  const masterHint = document.createElement('span');
  masterHint.className = 'mlHint';
  masterHint.textContent = '잠긴 항목끼리 비율 연동 · 단위 cm';
  master.appendChild(masterBtn); master.appendChild(masterHint);
  if (measures.length) colRight.appendChild(master);
  // 실측은 2열 그리드로 촘촘하게 항상 표시합니다(접지 않음).
  const rowsGrid = document.createElement('div');
  rowsGrid.className = 'specRowsGrid';
  if (measures.length) colRight.appendChild(rowsGrid);

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
    const target = !allLocked;
    for (const ref of lockable) { ref.m._locked = target; applyLockVisual(ref); }
    refreshMaster();
  });

  measures.forEach((m) => {
    const len = measurePixelLen(m, img);
    const hasLine = len != null;
    if (m._locked === undefined) m._locked = hasLine;
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
      ? '잠금(🔒): 다른 잠긴 항목과 비율 연동 / 풀림(🔓): 연동에서 제외(독립)'
      : '측정선이 없어 비율 연동을 할 수 없는 항목입니다.';

    const ref = { m, input: value, lockBtn, badge: aiTag, hasLine, len };
    rowRefs.push(ref);
    applyLockVisual(ref);

    value.addEventListener('input', () => {
      m.value_cm = parseFloat(value.value);
      m._ai = false;
      aiTag.classList.add('hidden');
      if (m._locked && hasLine) propagateLocked(spec, img, m, rowRefs);
      redrawOverlay();
    });
    lockBtn.addEventListener('click', () => {
      if (!hasLine) return;
      m._locked = !m._locked;
      applyLockVisual(ref);
      refreshMaster();
    });

    row.appendChild(label); row.appendChild(value); row.appendChild(unit);
    row.appendChild(aiTag); row.appendChild(lockBtn);
    rowsGrid.appendChild(row);
  });
  refreshMaster();
  applyFold();
}

// 섹션별 [모두 접기 / 모두 펼치기]. 카드가 길어 하나씩 접는 것도 번거롭기 때문입니다.
function foldAllIn(gridId, folded) {
  const lists = gridId === 'specGrid'
    ? activeGarmentSlots().map((k) => specs[k])
    : [wornItems[gridId === 'accGrid' ? 'acc' : 'shoes']];
  for (const list of lists) {
    for (const entry of list) if (entry) entry._folded = folded;
  }
  renderSpecs();
}
for (const btn of document.querySelectorAll('.foldAllBtn')) {
  btn.addEventListener('click', () => {
    const folding = btn.textContent.includes('접기');
    foldAllIn(btn.dataset.grid, folding);
    btn.textContent = folding ? '모두 펼치기' : '모두 접기';
  });
}

// 설명 칸은 내용만큼 늘립니다. 고정 높이면 두 줄만 보이고 나머지는 스크롤에 숨어,
// AI가 뭘 썼는지 확인하려면 칸마다 스크롤해야 했습니다(최대 8줄까지만 늘림).
function autoSizeDesc(textarea) {
  if (!textarea.isConnected) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 8 * 18 + 22)}px`;
}

// 겹 라벨: 한 벌뿐이면 "상의", 여러 겹이면 "상의 L1 (이너)" 식.
function layerTitle(slotKey, index, total) {
  const base = SLOT_TITLE[slotKey];
  if (total <= 1) return base;
  const role = index === 0 ? '이너' : index === total - 1 ? '겉' : '중간';
  return `${base} L${index + 1} (${role})`;
}

// 옷 / 액세서리 / 신발을 각각의 영역에 같은 형식(같은 spec box, 같은 사진 크기)으로 그립니다.
function renderSpecs() {
  specGrid.innerHTML = '';
  accGrid.innerHTML = '';
  shoesGrid.innerHTML = '';

  // 업로드된 사진 기준으로 그립니다(분석 결과 기준이 아니라). 아직 분석하지 않은 사진도
  // 자리를 지키고 [분석하기] 버튼을 갖게 되므로, 사진을 새로 올린 뒤 그 항목만 태울 수 있습니다.
  let garmentCount = 0;
  for (const slotKey of activeGarmentSlots()) {
    files[slotKey].forEach((file, i) => {
      garmentCount++;
      const box = document.createElement('div');
      box.className = 'specBox';
      specGrid.appendChild(box);
      const entry = specs[slotKey][i];
      const title = layerTitle(slotKey, i, files[slotKey].length);
      const ref = { key: slotKey, index: i };
      if (entry && entry.spec) renderSpecBox(box, entry, title, 'garment', ref);
      else renderPendingBox(box, file, title, 'garment', ref);
    });
  }

  const renderWorn = (key, grid, kind, baseTitle) => {
    files[key].forEach((file, i) => {
      const box = document.createElement('div');
      box.className = 'specBox';
      grid.appendChild(box);
      const entry = wornItems[key][i];
      const title = files[key].length > 1 ? `${baseTitle} ${i + 1}` : baseTitle;
      const ref = { key, index: i };
      if (entry && entry.spec) renderSpecBox(box, entry, title, kind, ref);
      else renderPendingBox(box, file, title, kind, ref);
    });
    return files[key].length;
  };
  const accCount = renderWorn('acc', accGrid, 'accessory', '액세서리');
  const shoesCount = renderWorn('shoes', shoesGrid, 'shoes', '신발');

  for (const ta of document.querySelectorAll('.descField textarea')) autoSizeDesc(ta);

  garmentSection.classList.toggle('hidden', garmentCount === 0);
  accSection.classList.toggle('hidden', accCount === 0);
  shoesSection.classList.toggle('hidden', shoesCount === 0);
  specPlaceholder.style.display = (garmentCount + accCount + shoesCount) ? 'none' : '';
}

// ---- 지시사항 / FIT MAP ----
const INSTRUCTION_GROUPS = [
  { key: 'top', label: '상의' },
  { key: 'bottom', label: '하의' },
  { key: 'dress', label: '원피스' },
  { key: 'overall', label: '전체 / 레이어링' },
];
// "전체"로 분류된 항목을 성격별로 다시 나눕니다. 마지막 항목이 나머지를 모두 받습니다.
const OVERALL_SUBGROUPS = [
  { label: '액세서리', match: (c) => /액세서리|가방|모자|스카프|목도리|선글라스|벨트|장갑|착용/.test(c) },
  { label: '신발', match: (c) => /신발|슈즈|부츠|굽/.test(c) },
  { label: '레이어링 / 겹침', match: () => true },
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

// FIT MAP은 코드가 계산한 중간 산출물이라 화면에는 그리지 않습니다(사용자가 읽을 것이
// 아니라 아래 지시사항 문장의 재료입니다). 값 자체는 lastFitMap에 그대로 남아 있어,
// 디버깅이 필요하면 콘솔에서 window.lastFitMap으로 확인할 수 있습니다.
function renderFitMap() {
  fitMapWrap.innerHTML = '';
  window.lastFitMap = lastFitMap;
}

function renderFittingItems() {
  instructionsWrap.innerHTML = '';
  instructionsPlaceholder.style.display = (fittingItems.length || lastFitMap) ? 'none' : '';
  // 같은 슬롯에 여러 겹이 있으면 겹마다 묶어서 보여줍니다. 한 묶음에 이너와 겉옷 문장이
  // 섞이면 어느 옷 이야기인지 읽기 어려웠습니다(모델이 문장마다 옷 이름을 다시 붙여야 했음).
  const sections = [];
  for (const group of INSTRUCTION_GROUPS) {
    const inGroup = fittingItems
      .map((item, index) => ({ item, index }))
      .filter((e) => e.item.garment === group.key);
    if (!inGroup.length) continue;
    const layers = [];
    for (const e of inGroup) {
      const key = (e.item.layer || '').trim();
      let bucket = layers.find((l) => l.key === key);
      if (!bucket) { bucket = { key, entries: [] }; layers.push(bucket); }
      bucket.entries.push(e);
    }
    for (const l of layers) {
      // "전체" 묶음에는 레이어링·액세서리·신발이 한꺼번에 들어와 정신이 없었습니다.
      // 겹 라벨이 없는 항목들이라 카테고리로 다시 쪼개 각각 제목을 답니다.
      if (group.key === 'overall') {
        // 항목마다 "가장 먼저 맞는" 소그룹 하나에만 넣습니다(중복 표시 방지).
        const buckets = OVERALL_SUBGROUPS.map((sub) => ({ sub, entries: [] }));
        for (const e of l.entries) {
          const hit = buckets.find((b) => b.sub.match(e.item.category || ''));
          if (hit) hit.entries.push(e);
        }
        for (const b of buckets) {
          if (b.entries.length) sections.push({ label: b.sub.label, entries: b.entries });
        }
        continue;
      }
      // 겹이 하나뿐이면 굳이 "상의 L1 (이너)"라고 쓰지 않고 슬롯 이름만 씁니다.
      const label = layers.length > 1 && l.key ? l.key : group.label;
      sections.push({ label, entries: l.entries });
    }
  }

  for (const group of sections) {
    const entries = group.entries;
    const section = document.createElement('div');
    section.className = 'instrGroup';
    const title = document.createElement('div');
    title.className = 'instrGroupTitle';
    title.textContent = group.label;
    section.appendChild(title);
    for (const { item, index } of entries) {
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
      row.appendChild(cat); row.appendChild(text);
      section.appendChild(row);
    }
    instructionsWrap.appendChild(section);
  }
  for (const ta of instructionsWrap.querySelectorAll('.instrText')) autoSizeInstr(ta);
}

// ---- 1단계: 모델 체형 분석 ----
analyzeModelBtn.addEventListener('click', async () => {
  if (!files.model.length) { setStatus('모델 이미지를 먼저 선택하세요.'); return; }
  analyzeModelBtn.disabled = true;
  setStatus('모델 사진에서 신체 실측을 추정하는 중...');
  const timer = startTimer(modelElapsed, '모델');
  try {
    const dataUrl = await toUploadDataUrl(files.model[0]);
    const res = await fetch('/api/v23/analyze-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: dataUrl }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    modelSpec = data.model;
    modelSpecImg = await loadImageFromFile(files.model[0]);
    renderModelSpec();
    timer.stop(true);
    setStatus('모델 체형 분석 완료. 값을 확인/수정한 뒤 [옷 분석]으로 진행하세요.');
  } catch (err) {
    console.error(err); timer.stop(false); setStatus('실패: ' + err.message);
  } finally { refreshButtonStates(); }
});

// ---- 2단계: 옷 실측 분석(겹마다) + 액세서리/신발 이름 분류 ----
// 한 장씩 분석합니다. 사진 한 장만 바꿨을 때 전체를 다시 태우면 다른 아이템에 손으로
// 고쳐 둔 실측·설명이 전부 날아가므로, 항목 단위로 분리해 두고 필요한 것만 돌립니다.
async function analyzeGarmentAt(slotKey, i, analysisModel) {
  const file = files[slotKey][i];
  const dataUrl = await toUploadDataUrl(file);
  const res = await fetch('/api/v23/analyze-garments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ garment: dataUrl, slot: slotKey, analysisModel }),
  });
  const data = await parseJsonOrThrow(res);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const prev = specs[slotKey][i];
  specs[slotKey][i] = {
    spec: data.spec,
    img: await loadImageFromFile(file),
    include: prev ? prev.include : false,
  };
}

async function analyzeWornAt(key, i, analysisModel) {
  const file = files[key][i];
  const dataUrl = await toUploadDataUrl(file);
  const res = await fetch('/api/v25/classify-item', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, kind: key === 'shoes' ? 'shoes' : 'accessory', analysisModel }),
  });
  const data = await parseJsonOrThrow(res);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const prev = wornItems[key][i];
  // 옷과 같은 형태로 담아 동일한 spec box(사진+실측+비율 잠금)로 그립니다.
  wornItems[key][i] = {
    spec: {
      garment_type: data.item.name,
      description: data.item.description || '',
      design: data.item.design || '',
      material_color: data.item.material_color || '',
      details: data.item.details || '',
      measurements: data.item.measurements || [],
    },
    img: await loadImageFromFile(file),
    include: prev ? prev.include : false,
    worn_on: data.item.worn_on,
    wear_style: data.item.wear_style,
  };
}

// 개별 박스의 [재분석] 버튼. 그 아이템만 다시 태우고 나머지는 그대로 둡니다.
async function reanalyzeOne(kind, key, i, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '분석 중...';
  try {
    if (kind === 'garment') await analyzeGarmentAt(key, i, selectedAnalysisModel());
    else await analyzeWornAt(key, i, selectedAnalysisModel());
    renderSpecs();
    setStatus('해당 항목만 다시 분석했습니다.');
  } catch (err) {
    console.error(err);
    button.disabled = false;
    button.textContent = label;
    setStatus(`재분석 실패: ${err.message || err}`);
  }
  refreshButtonStates();
}

analyzeBtn.addEventListener('click', async () => {
  if (!requiredImagesPresent()) {
    setStatus(isDress() ? '모델 사진과 원피스/세트 사진이 필요합니다.' : '모델·상의·하의 사진이 필요합니다.');
    return;
  }
  analyzeBtn.disabled = true;
  const timer = startTimer(garmentElapsed, '옷 분석');

  const analysisModel = selectedAnalysisModel();
  const jobs = [];
  // 아직 분석 결과가 없는 사진만 태웁니다. 이미 분석한 항목은 손으로 고친 값을 지키기
  // 위해 건드리지 않습니다 — 다시 돌리려면 그 항목의 [재분석]을 누르면 됩니다.
  for (const slotKey of activeGarmentSlots()) {
    files[slotKey].forEach((_, i) => {
      if (specs[slotKey][i] && specs[slotKey][i].spec) return;
      jobs.push(analyzeGarmentAt(slotKey, i, analysisModel));
    });
  }
  for (const key of ITEM_SLOTS) {
    files[key].forEach((_, i) => {
      if (wornItems[key][i] && wornItems[key][i].spec) return;
      jobs.push(analyzeWornAt(key, i, analysisModel));
    });
  }

  if (!jobs.length) {
    timer.stop(true);
    setStatus('새로 분석할 사진이 없습니다. 특정 항목을 다시 분석하려면 그 항목의 [재분석]을 누르세요.');
    refreshButtonStates();
    return;
  }
  setStatus(`분석할 사진 ${jobs.length}장을 처리하는 중...`);

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  renderSpecs();

  timer.stop(failed.length === 0);
  if (failed.length) {
    console.error(failed.map((f) => f.reason));
    setStatus(`일부 분석 실패 (${failed.length}건): ${failed[0].reason?.message || ''}`);
  } else {
    setStatus('분석 완료. 아는 실측이 있으면 고치고(잠긴 항목은 비율 연동) [피팅 지시사항 생성]을 누르세요.');
  }
  refreshButtonStates();
});

// ---- 3단계: 핏/기장 지시사항 (레이어별 착지점 + 겹침 관계) ----
instructionsBtn.addEventListener('click', async () => {
  if (!(specsReady() && modelSpec)) { setStatus('먼저 모델 체형 분석과 옷 분석을 완료하세요.'); return; }
  instructionsBtn.disabled = true;
  setStatus('코드가 겹별 착지점과 겹침 관계를 계산하고, 선택한 모델이 문장으로 옮기는 중...');
  const timer = startTimer(instrElapsed, '지시사항');
  try {
    const payload = { modelSpec, fittingModel: selectedFittingModel() };
    for (const slotKey of activeGarmentSlots()) {
      payload[`${slotKey}Specs`] = specs[slotKey].map((e) => e.spec);
      payload[`${slotKey}Images`] = await Promise.all(files[slotKey].map((f) => toUploadDataUrl(f)));
    }
    // 액세서리/신발도 FIT MAP 계산에 넘깁니다. 착용 방법(어깨/크로스/손 …)에 따라 가방이
    // 매달리는 높이가 달라지고, 부츠 목높이는 다리 랜드마크로 환산되므로 지시사항에
    // 반드시 반영돼야 합니다.
    const wornPayload = (list) => list
      .filter((e) => e && e.spec)
      .map((e) => ({
        name: e.spec.garment_type,
        worn_on: e.worn_on,
        wear_style: e.wear_style,
        measurements: e.spec.measurements || [],
      }));
    payload.accessorySpecs = wornPayload(wornItems.acc);
    payload.shoesSpecs = wornPayload(wornItems.shoes);
    const res = await fetch('/api/v25/fitting-instructions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastFitMap = data.fitMap || null;
    fittingItems = data.items || [];
    renderFitMap();
    renderFittingItems();
    timer.stop(true);
    setStatus('지시사항 생성 완료. 옷별로 정리된 아래 문장은 직접 수정할 수 있습니다.');
  } catch (err) {
    console.error(err); timer.stop(false); setStatus('실패: ' + err.message);
  } finally { refreshButtonStates(); }
});

// ---- 결과 그리드 ----
function appendResultItem(src, labelText) {
  const item = document.createElement('div');
  item.className = 'resultItem';
  const img = document.createElement('img');
  img.src = src;
  img.addEventListener('click', () => openModal(img.src));
  const label = document.createElement('span');
  label.className = 'resultLabel';
  label.textContent = labelText;
  item.appendChild(img); item.appendChild(label);
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
  item.appendChild(box); item.appendChild(label);
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
      const res = await fetch('/api/v25/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      label.textContent = `${shotNo}번 · ${engineLabel} · ${took}초 · 참조 ${data.imageCount}장`;
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
  if (!(requiredImagesPresent() && instrOk && engines.length)) {
    setStatus('필수 사진, 피팅 지시사항(또는 "핏 지시사항 없이"), 생성 모델 1개 이상이 필요합니다.');
    return;
  }
  setStatus('이미지 업로드 준비 중...');
  const items = fittingItems.filter((i) => i.instruction.trim()).map((i) => ({ ...i }));
  const payload = { items, model: await toUploadDataUrl(files.model[0]) };
  if (noInstrCheck.checked) payload.noInstructions = true;

  for (const slotKey of activeGarmentSlots()) {
    payload[`${slotKey}Images`] = await Promise.all(files[slotKey].map((f) => toUploadDataUrl(f)));
  }
  payload.accessoryImages = await Promise.all(files.acc.map((f) => toUploadDataUrl(f)));
  payload.accessoryNames = wornItems.acc.map((e) => (e && e.spec && e.spec.garment_type) || '');
  payload.accessoryStyles = wornItems.acc.map((e) => (e && e.wear_style) || '');
  payload.shoesImages = await Promise.all(files.shoes.map((f) => toUploadDataUrl(f)));
  payload.shoesNames = wornItems.shoes.map((e) => (e && e.spec && e.spec.garment_type) || '');

  // [포함하기]를 켠 옷의 종류/설명만 GARMENT DESCRIPTION으로 넘깁니다(겹 이름을 붙여 구분).
  // 항목 라벨을 붙여 여러 줄로 넘기는 이유: 한 문단으로 뭉쳐 보내면 이미지 모델이 뒤쪽
  // 항목(대개 디테일)을 흘립니다. 라벨이 붙어 있으면 항목별로 각각 반영합니다.
  const describeEntry = (title, spec) => {
    const head = [title, spec.garment_type].filter(Boolean).join(': ');
    const lines = DESC_FIELDS
      .filter((f) => (spec[f.key] || '').trim())
      .map((f) => `  · ${f.label}: ${spec[f.key].trim()}`);
    // 세 칸이 모두 비었을 때만 예전 한 줄 설명으로 대체합니다(구버전 분석 결과 호환).
    if (!lines.length && (spec.description || '').trim()) lines.push(`  · ${spec.description.trim()}`);
    return lines.length ? [head, ...lines].join('\n') : '';
  };

  const descriptions = [];
  for (const slotKey of activeGarmentSlots()) {
    specs[slotKey].forEach((entry, i) => {
      if (!entry || !entry.include || !entry.spec) return;
      const body = describeEntry(layerTitle(slotKey, i, specs[slotKey].length), entry.spec);
      if (body) descriptions.push(body);
    });
  }
  // 액세서리·신발도 [포함하기]를 켜면 같은 방식으로 외형 설명을 넘깁니다. 이게 빠져 있으면
  // 체크박스를 켜도 아무 효과가 없어, 이미지 모델이 액세서리 외형을 사진만 보고 짐작합니다.
  for (const [key, label] of [['acc', '액세서리'], ['shoes', '신발']]) {
    wornItems[key].forEach((entry, i) => {
      if (!entry || !entry.include || !entry.spec) return;
      const n = wornItems[key].length;
      const body = describeEntry(n > 1 ? `${label} ${i + 1}` : label, entry.spec);
      if (body) descriptions.push(body);
    });
  }
  payload.garmentDescriptions = descriptions;

  for (const engine of engines) runSynthShot(payload, engine);
  setStatus(`${engines.length}개 모델로 피팅샷 생성 중... (모델마다 1~2분 걸릴 수 있어요)`);
});

renderUploadArea();
refreshButtonStates();
