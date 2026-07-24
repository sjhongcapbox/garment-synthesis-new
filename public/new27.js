// 피팅샷 v2.6 — v2.5 구조를 유지하되, 상의/하의/원피스 슬롯 구분을 없앴습니다.
//  · 옷을 아무거나 한 슬롯(최대 5장)에 올리면, 분석 단계에서 AI가 종류(상의/하의/원피스/세트)를
//    스스로 판정합니다. 오판은 각 카드의 [종류] 드롭다운으로 고치면 그 종류로 다시 분석합니다.
//  · 원피스와 아우터(상의)가 공존할 수 있고(예: 원피스 위에 코트), 코드가 겹침 관계를 판정합니다.
//  · 액세서리 2개 / 신발 1개 — v2.5와 동일.
// 모델 분석은 v2.3(/api/v23/analyze-model), 옷 종류 자동판정·핏·합성은 /api/v27/*를 씁니다.

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
const layerBar = document.getElementById('layerBar');
const accSection = document.getElementById('accSection');
const shoesSection = document.getElementById('shoesSection');
const specPlaceholder = document.getElementById('specPlaceholder');
const analyzeModelBtn = document.getElementById('analyzeModelBtn');
const modelSpecBox = document.getElementById('modelSpecBox');
const modelSpecPlaceholder = document.getElementById('modelSpecPlaceholder');
// v2.7 체형 선택
const bodyTypeSection = document.getElementById('bodyTypeSection');
const openBodyModalBtn = document.getElementById('openBodyModalBtn');
const selectedBodyLabel = document.getElementById('selectedBodyLabel');
const bodyModal = document.getElementById('bodyModal');
const bodyModalGrid = document.getElementById('bodyModalGrid');
const bodyModalClose = document.getElementById('bodyModalClose');
const reshapeBtn = document.getElementById('reshapeBtn');
const reshapeElapsed = document.getElementById('reshapeElapsed');
const reshapeHint = document.getElementById('reshapeHint');
// 헤어/색상
const openHairModalBtn = document.getElementById('openHairModalBtn');
const hairLabel = document.getElementById('hairLabel');
const hairColorRow = document.getElementById('hairColorRow');
const hairModal = document.getElementById('hairModal');
const hairModalGrid = document.getElementById('hairModalGrid');
const hairModalClose = document.getElementById('hairModalClose');
if (openBodyModalBtn) openBodyModalBtn.addEventListener('click', openBodyModal);
if (bodyModalClose) bodyModalClose.addEventListener('click', closeBodyModal);
if (bodyModal) bodyModal.addEventListener('click', (e) => { if (e.target === bodyModal) closeBodyModal(); });
if (openHairModalBtn) openHairModalBtn.addEventListener('click', openHairModal);
if (hairModalClose) hairModalClose.addEventListener('click', closeHairModal);
if (hairModal) hairModal.addEventListener('click', (e) => { if (e.target === hairModal) closeHairModal(); });
const clearResultsBtn = document.getElementById('clearResultsBtn');
const fitMapWrap = document.getElementById('fitMapWrap');
const engineChecks = document.getElementById('engineChecks');
const engineAllBtn = document.getElementById('engineAllBtn');
const noInstrCheck = document.getElementById('noInstrCheck');
const showArrowsCheck = document.getElementById('showArrowsCheck');
const showModelArrowsCheck = document.getElementById('showModelArrowsCheck');
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
  { value: 'gpt-image-2-high-2k', label: 'GPT Image-2 (High 2K)' },
  { value: 'gpt-image-2-high-1k', label: 'GPT Image-2 (High 1K)' },
  { value: 'gpt-image-2-medium-2k', label: 'GPT Image-2 (Medium 2K)' },
  { value: 'gpt-image-2-medium-1k', label: 'GPT Image-2 (Medium 1K)' },
];
const ENGINE_LABELS = Object.fromEntries(ENGINES.map((e) => [e.value, e.label]));
const DEFAULT_ENGINE = 'gpt-image-2-medium-2k';

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
  { key: 'model', label: '모델 사진', max: 1, hint: '전신 1장' },
  { key: 'garment', label: '옷 (아무거나)', max: 5, hint: '상의·하의·원피스·세트 섞어서 OK. 겹쳐 입는 순서대로(안→밖) 올리면 좋아요.' },
  { key: 'acc', label: '액세서리', max: 2, hint: '모자·목도리·선글라스·가방 등. 없으면 미착용' },
  { key: 'shoes', label: '신발', max: 1, hint: '없으면 AI가 자동 매칭' },
];
const GARMENT_SLOTS = ['garment'];
const ITEM_SLOTS = ['acc', 'shoes'];
const SLOT_TITLE = { garment: '옷' };
// 카테고리 라벨. set(세트)은 계산상 원피스처럼 다뤄집니다(서버가 상하의로 쪼갬).
const CATEGORY_LABEL = { top: '상의', bottom: '하의', dress: '원피스', set: '상하의 세트' };
const CATEGORY_ORDER = ['dress', 'set', 'top', 'bottom'];

const files = { model: [], garment: [], acc: [], shoes: [] };
// 옷 분석 결과: [{ spec, img, include, category }] — index가 곧 업로드/겹 순서
const specs = { garment: [] };
// 추가 뷰(같은 옷의 뒤/옆 각도): garmentViews[i] = [{ file, img }] — files.garment[i]와 index 동기화.
// 측정·종류판정은 대표사진(files.garment[i])만 쓰고, 추가 뷰는 합성 때 외형 참고용으로만 넘깁니다.
const garmentViews = [];
const MAX_VIEWS = 3;
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

// v2.6은 모드 구분이 없습니다(옷 종류를 자동 판정하므로). 슬롯은 항상 전부 활성.
const activeSlots = () => SLOTS;
const activeGarmentSlots = () => GARMENT_SLOTS;

// 옷 카드 제목: 같은 카테고리가 여러 장이면 "상의 L2 (겉)"처럼 겹 번호를 붙입니다.
// 겹 순서는 업로드 순서(index)를 따르되, 카테고리별로 따로 셉니다.
function garmentTitleAt(i) {
  const entry = specs.garment[i];
  const cat = (entry && entry.category) || 'top';
  const base = CATEGORY_LABEL[cat] || '옷';
  const sameIdx = [];
  specs.garment.forEach((e, j) => { if (e && (e.category || 'top') === cat) sameIdx.push(j); });
  if (sameIdx.length <= 1) return base;
  const pos = sameIdx.indexOf(i);
  const role = pos === 0 ? '이너' : pos === sameIdx.length - 1 ? '겉' : '중간';
  return `${base} L${pos + 1} (${role})`;
}

// 같은 종류(카테고리) 안에서 i번 옷의 이웃(더 안쪽/더 바깥) index를 찾습니다. 없으면 -1.
// dir: -1 = 더 안쪽(리스트에서 앞), +1 = 더 바깥(뒤).
function sameCategoryNeighbor(i, dir) {
  const entry = specs.garment[i];
  if (!entry) return -1;
  const cat = entry.category || 'top';
  for (let j = i + dir; j >= 0 && j < specs.garment.length; j += dir) {
    const e = specs.garment[j];
    if (e && (e.category || 'top') === cat) return j;
  }
  return -1;
}

// 사용자가 겹 순서를 손으로 바꾸면 true. 이후 자동 정렬은 사용자 의도를 존중해 멈춥니다.
let manualLayerOverride = false;

// i번 옷을 같은 종류의 이웃과 자리 바꿔 겹 순서를 조정합니다(사진·분석결과 함께 이동).
function moveGarmentLayer(i, dir) {
  const j = sameCategoryNeighbor(i, dir);
  if (j < 0) return;
  manualLayerOverride = true; // 이제부터 자동 정렬은 하지 않습니다.
  [files.garment[i], files.garment[j]] = [files.garment[j], files.garment[i]];
  [specs.garment[i], specs.garment[j]] = [specs.garment[j], specs.garment[i]];
  [garmentViews[i], garmentViews[j]] = [garmentViews[j], garmentViews[i]];
  // 겹 순서가 바뀌면 이전 지시사항은 더 이상 맞지 않으므로 비우고 다시 만들게 합니다.
  fittingItems = [];
  lastFitMap = null;
  renderUploadArea();
  renderSpecs();
  renderFittingItems();
  refreshButtonStates();
  setStatus('겹 순서를 바꿨습니다. [피팅 지시사항 생성]을 다시 눌러 주세요.');
}

// 옷의 "겉옷다움" 점수. 낮을수록 안쪽(이너), 높을수록 바깥(겉).
// 추가 AI 호출 없이 옷종류 키워드 + 실측(둘레)만으로 추정합니다.
function layerRank(entry) {
  const spec = entry.spec || {};
  const t = `${spec.garment_type || ''} ${spec.design || ''} ${spec.material_color || ''}`;
  let base;
  if (/코트|트렌치|패딩|다운|점퍼|블루종|야상|파카|무스탕|아노락|아우터/.test(t)) base = 90; // 최외곽 겉옷
  else if (/자켓|재킷|블레이저|가디건|집업|베스트|조끼|볼레로/.test(t)) base = 70; // 겉에 걸침
  else if (/셔츠|남방|블라우스/.test(t)) base = 45; // 셔츠류(중간)
  else if (/니트|스웨터|맨투맨|후드티|후디|티셔츠|반팔|긴팔|탑|캐미솔|슬리브리스|나시|이너|언더/.test(t)) base = 30; // 베이스
  else base = 50; // 판단 애매 → 중간
  // 같은 부류 안에서는 둘레가 클수록 바깥. 부류 차이(20)를 넘지 않게 작은 값만 더합니다.
  const size = ['가슴단면', '허리단면', '엉덩이단면', '힙단면']
    .map((lab) => (spec.measurements || []).find((m) => (m.label || '').replace(/\s/g, '').includes(lab.replace('단면', ''))))
    .map((m) => (m ? m.value_cm : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  return base + Math.min(size, 90) / 1000; // 최대 +0.09 → 타이브레이커로만 작용
}

// 같은 종류 옷을 안→밖 순서로 1차 자동 정렬합니다(사용자가 손대기 전까지). 카테고리 간
// 상대 위치는 유지하고, 각 카테고리 내부 아이템만 자기 자리들 안에서 rank 순으로 재배치합니다.
function autoOrderLayers() {
  if (manualLayerOverride) return false;
  let changed = false;
  const byCat = {};
  specs.garment.forEach((e, i) => {
    if (!e || !e.spec) return;
    (byCat[e.category || 'top'] ||= []).push(i);
  });
  for (const idxs of Object.values(byCat)) {
    if (idxs.length < 2) continue;
    const sorted = idxs.map((i) => i).sort((a, b) => layerRank(specs.garment[a]) - layerRank(specs.garment[b]));
    if (sorted.some((i, k) => i !== idxs[k])) changed = true;
    const f = sorted.map((i) => files.garment[i]);
    const s = sorted.map((i) => specs.garment[i]);
    const v = sorted.map((i) => garmentViews[i]);
    idxs.forEach((slot, k) => { files.garment[slot] = f[k]; specs.garment[slot] = s[k]; garmentViews[slot] = v[k]; });
  }
  return changed;
}

// 자동 그룹핑: "같은 실물 옷의 다른 각도" 사진을 대표 1장 + 뷰(뒤·옆)로 묶습니다.
// 첫 일괄 분석(모든 옷 카드가 아직 미분석)일 때만 동작해, 이미 분석·수정한 카드 구조는 건드리지 않습니다.
// (증분 추가/수정은 수동 [+뷰]와 카드의 [합치기]/[분리]로 처리)
async function autoGroupGarments(analysisModel) {
  const n = files.garment.length;
  if (n < 2) return false;
  if (specs.garment.some((e) => e && e.spec)) return false; // 이미 분석된 카드가 있으면 건너뜀
  let groups;
  try {
    const images = await Promise.all(files.garment.map((f) => toUploadDataUrl(f)));
    const res = await fetch('/api/v27/group-garments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, analysisModel }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    groups = data.groups;
  } catch (err) {
    console.error('자동 그룹핑 실패 — 그룹핑 없이 진행합니다:', err);
    return false;
  }
  // 유효성 검사: 0..n-1이 정확히 한 번씩만 등장해야 재구성. 하나라도 어긋나면 안전하게 원본 유지.
  if (!Array.isArray(groups) || !groups.length) return false;
  const seen = new Set();
  const norm = [];
  for (const g of groups) {
    const rep = g.representative_index;
    const views = Array.isArray(g.view_indices) ? g.view_indices : [];
    for (const m of [rep, ...views]) {
      if (!Number.isInteger(m) || m < 0 || m >= n || seen.has(m)) return false;
      seen.add(m);
    }
    norm.push({ rep, views });
  }
  if (seen.size !== n) return false;   // 일부 사진 누락 → 위험하니 취소
  if (norm.length === n) return false; // 전부 단독 그룹 → 바뀔 게 없음
  // 재구성: 대표만 카드로 남기고, 나머지는 대표의 뷰(garmentViews)로 접습니다. (사진 손실 없음)
  const newFiles = [];
  const newViews = [];
  for (const { rep, views } of norm) {
    newFiles.push(files.garment[rep]);
    newViews.push(views.map((vi) => ({ file: files.garment[vi], img: null })));
  }
  files.garment = newFiles;
  specs.garment = newFiles.map(() => undefined); // 대표들은 아직 미분석 → 이어서 분석됩니다.
  garmentViews.length = 0;
  newViews.forEach((v) => garmentViews.push(v));
  return true;
}

// [분리] 카드의 특정 뷰를 별도 옷 카드로 빼냅니다(그룹핑 오판 교정).
function splitViewToGarment(gi, k) {
  const v = garmentViews[gi][k];
  if (!v) return;
  garmentViews[gi].splice(k, 1);
  files.garment.splice(gi + 1, 0, v.file);
  specs.garment.splice(gi + 1, 0, undefined);
  garmentViews.splice(gi + 1, 0, []);
  // 옷 구성이 바뀌면 이전 핏 지시사항/FIT MAP은 더 이상 맞지 않으므로 비우고 화면도 지웁니다.
  fittingItems = []; lastFitMap = null;
  onUploadChanged(); renderFittingItems();
  setStatus('뷰를 별도 옷으로 분리했습니다. [옷 분석] 또는 그 카드의 [분석하기]로 분석 후, [피팅 지시사항 생성]을 다시 누르세요.');
}

// [합치기] 이 옷 카드(+자기 뷰들)를 다른 옷 카드의 뷰로 옮깁니다(같은 옷을 다르게 잡았을 때 교정).
function mergeGarmentInto(sourceIdx, targetIdx) {
  if (sourceIdx === targetIdx) return;
  const movedFiles = [files.garment[sourceIdx], ...garmentViews[sourceIdx].map((v) => v.file)];
  garmentViews[targetIdx].push(...movedFiles.map((file) => ({ file, img: null })));
  files.garment.splice(sourceIdx, 1);
  specs.garment.splice(sourceIdx, 1);
  garmentViews.splice(sourceIdx, 1);
  // 옷 구성이 바뀌면 이전 핏 지시사항/FIT MAP은 더 이상 맞지 않으므로 비우고 화면도 지웁니다.
  fittingItems = []; lastFitMap = null;
  onUploadChanged(); renderFittingItems();
  setStatus('두 옷을 하나로 합쳤습니다(선택한 옷의 다른 각도 뷰로 이동). [피팅 지시사항 생성]을 다시 누르세요.');
}

// 뷰(다른 각도)를 다른 옷으로 옮깁니다. 옷 개수는 그대로라 핏 지시사항은 유지됩니다(재생성 불필요).
function moveViewToGarment(fromGi, k, toGi) {
  if (fromGi === toGi) return;
  const v = garmentViews[fromGi] && garmentViews[fromGi][k];
  if (!v) return;
  garmentViews[fromGi].splice(k, 1);
  (garmentViews[toGi] || (garmentViews[toGi] = [])).push({ file: v.file, img: v.img || null });
  onUploadChanged();
  setStatus('사진을 다른 옷의 각도(뷰)로 옮겼어요.');
}

// 레이어 칩 드래그로 같은 종류 안의 겹 순서(안→밖)를 바꿉니다. moveGarmentLayer와 같은 후처리.
function reorderLayer(catKey, fromPos, toPos) {
  const slots = [];
  specs.garment.forEach((e, i) => { if (e && e.spec && (e.category || 'top') === catKey) slots.push(i); });
  if (fromPos < 0 || fromPos >= slots.length || toPos < 0 || toPos >= slots.length) return;
  const order = slots.slice();
  const [moved] = order.splice(fromPos, 1);
  order.splice(toPos, 0, moved);
  if (order.every((v, k) => v === slots[k])) return; // 변화 없음
  manualLayerOverride = true;
  const f = order.map((i) => files.garment[i]);
  const s = order.map((i) => specs.garment[i]);
  const v = order.map((i) => garmentViews[i]);
  slots.forEach((slot, k) => { files.garment[slot] = f[k]; specs.garment[slot] = s[k]; garmentViews[slot] = v[k]; });
  // 겹 순서(가림 관계)가 바뀌면 이전 지시사항은 더 이상 맞지 않으므로 비우고 다시 만들게 합니다.
  fittingItems = []; lastFitMap = null;
  onUploadChanged(); renderFittingItems();
  setStatus('겹침 순서를 바꿨어요. [피팅 지시사항 생성]을 다시 누르세요.');
}

// ===== 드래그 앤 드롭 교정 (사진을 끌어 합치기/분리/뷰이동) =====
let dragState = null;  // { kind:'view'|'garment', gi, k? }
let layerDrag = null;  // { catKey, fromPos }

// 사진 썸네일/대표사진을 드래그 소스로 만듭니다.
function makeDraggablePhoto(el, payload) {
  el.setAttribute('draggable', 'true');
  el.classList.add('draggablePhoto');
  el.addEventListener('dragstart', (e) => {
    dragState = payload;
    document.body.classList.add('dndActive');
    if (payload.kind === 'view') document.body.classList.add('dndView');
    try { e.dataTransfer.setData('text/plain', 'garment-photo'); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    dragState = null;
    document.body.classList.remove('dndActive', 'dndView');
    for (const t of document.querySelectorAll('.dropOver')) t.classList.remove('dropOver');
  });
}

// 옷 카드를 드롭 대상으로 만듭니다: 뷰를 놓으면 그 옷의 각도로 이동, 대표사진을 놓으면 두 옷을 합침.
function makeGarmentDropTarget(box, gi) {
  box.addEventListener('dragover', (e) => {
    if (!dragState || dragState.gi === gi) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    box.classList.add('dropOver');
  });
  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('dropOver');
  });
  box.addEventListener('drop', (e) => {
    if (!dragState || dragState.gi === gi) return;
    e.preventDefault();
    box.classList.remove('dropOver');
    const d = dragState;
    dragState = null;
    document.body.classList.remove('dndActive', 'dndView');
    if (d.kind === 'view') moveViewToGarment(d.gi, d.k, gi);
    else if (d.kind === 'garment') mergeGarmentInto(d.gi, gi);
  });
}

// "별도 옷으로 분리" 드롭 존(뷰 사진 전용). 뷰를 놓으면 독립 옷 카드가 됩니다.
function makeNewGarmentZone() {
  const zone = document.createElement('div');
  zone.className = 'newGarmentZone';
  zone.innerHTML = '<span>⤵ 사진을 여기로 끌어다 놓으면<br><b>별도의 옷</b>으로 분리돼요</span>';
  zone.addEventListener('dragover', (e) => {
    if (!dragState || dragState.kind !== 'view') return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    zone.classList.add('dropOver');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropOver'));
  zone.addEventListener('drop', (e) => {
    if (!dragState || dragState.kind !== 'view') return;
    e.preventDefault();
    zone.classList.remove('dropOver');
    const d = dragState;
    dragState = null;
    document.body.classList.remove('dndActive', 'dndView');
    splitViewToGarment(d.gi, d.k);
  });
  return zone;
}

// 겹침 순서 칩 바: 종류별로 안→밖 순서를 칩으로 보여주고, 드래그로 재정렬합니다.
function renderLayerBar() {
  if (!layerBar) return;
  layerBar.innerHTML = '';
  const CATS = [['top', '상의'], ['bottom', '하의'], ['dress', '원피스'], ['set', '세트']];
  let anyRow = false;
  for (const [catKey, label] of CATS) {
    const slots = [];
    specs.garment.forEach((e, i) => { if (e && e.spec && (e.category || 'top') === catKey) slots.push(i); });
    if (slots.length < 2) continue;
    anyRow = true;
    const row = document.createElement('div');
    row.className = 'layerBarRow';
    const lab = document.createElement('span');
    lab.className = 'layerBarLabel';
    lab.textContent = `${label} 겹침`;
    row.appendChild(lab);
    const inner = document.createElement('span'); inner.className = 'layerEnd'; inner.textContent = '안쪽'; row.appendChild(inner);
    const chips = document.createElement('div');
    chips.className = 'layerChips';
    slots.forEach((gi, pos) => {
      const chip = document.createElement('div');
      chip.className = 'layerChip';
      chip.textContent = specs.garment[gi].spec.garment_type || garmentTitleAt(gi);
      chip.setAttribute('draggable', 'true');
      chip.addEventListener('dragstart', (e) => {
        layerDrag = { catKey, fromPos: pos };
        chip.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'chip'); } catch (_) {}
      });
      chip.addEventListener('dragend', () => {
        layerDrag = null; chip.classList.remove('dragging');
        for (const c of chips.querySelectorAll('.layerChip')) c.classList.remove('chipOver');
      });
      chip.addEventListener('dragover', (e) => {
        if (!layerDrag || layerDrag.catKey !== catKey || layerDrag.fromPos === pos) return;
        e.preventDefault(); chip.classList.add('chipOver');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('chipOver'));
      chip.addEventListener('drop', (e) => {
        if (!layerDrag || layerDrag.catKey !== catKey) return;
        e.preventDefault(); chip.classList.remove('chipOver');
        const from = layerDrag.fromPos; layerDrag = null;
        reorderLayer(catKey, from, pos);
      });
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    const outer = document.createElement('span'); outer.className = 'layerEnd'; outer.textContent = '겉'; row.appendChild(outer);
    layerBar.appendChild(row);
  }
  layerBar.style.display = anyRow ? '' : 'none';
}

// 업로드/분석 항목을 그 자리(index)만 빼냅니다. 분석 전(사진만)·후(분석 결과) 모두 동작.
// 썸네일 X와 카드 X가 공유합니다.
function removeUploadedAt(slotKey, i) {
  files[slotKey].splice(i, 1);
  if (specs[slotKey]) specs[slotKey].splice(i, 1);
  if (wornItems[slotKey]) wornItems[slotKey].splice(i, 1);
  if (slotKey === 'garment') garmentViews.splice(i, 1);
  // 구성이 바뀌면 이전 지시사항/FIT MAP은 더 이상 맞지 않으므로 비웁니다.
  fittingItems = [];
  lastFitMap = null;
  onUploadChanged();
  renderFittingItems();
}

// 옷 카드를 카테고리 → 업로드순으로 버킷팅. 서버 payload(topSpecs/…)로 나눌 때 씁니다.
// set(세트)은 원피스 슬롯(dress*)으로 보냅니다(서버가 상하의로 분리 계산).
function bucketGarments() {
  const b = { top: [], bottom: [], dress: [] };
  specs.garment.forEach((e, i) => {
    if (!e || !e.spec) return;
    const cat = e.category || 'top';
    const dest = cat === 'top' ? 'top' : cat === 'bottom' ? 'bottom' : 'dress';
    b[dest].push(i);
  });
  return b;
}

let modelSpec = null;
let modelSpecImg = null;

// ===== v2.7 체형 선택 =====
// 체형은 "키 대비 비율"로 정의 → 적용 시 (모델 키 × 비율)로 환산. 몸무게는 BMI×키².
// ratios: 어깨너비/가슴둘레/허리둘레/엉덩이둘레 (키에 대한 비율). desc: 재렌더 프롬프트용 설명.
const BODY_PRESETS = [
  // ── 남성 (15) ──
  { id: 'm_skinny',     sex: 'm', name: '남 · 마른형',      bmi: 18.0, ratios: { shoulder: 0.248, chest: 0.480, waist: 0.385, hip: 0.495 }, desc: '매우 마른 남성 — 좁고 각진 어깨, 얇은 팔다리, 납작하고 가는 몸통' },
  { id: 'm_slim',       sex: 'm', name: '남 · 슬림',        bmi: 20.0, ratios: { shoulder: 0.262, chest: 0.515, waist: 0.405, hip: 0.510 }, desc: '날씬한 남성 — 군살 없이 매끈하고 곧은 남성 실루엣' },
  { id: 'm_std',        sex: 'm', name: '남 · 표준',        bmi: 22.0, ratios: { shoulder: 0.270, chest: 0.555, waist: 0.460, hip: 0.535 }, desc: '표준 남성 — 균형 잡힌 평균적인 남성 체형' },
  { id: 'm_straight',   sex: 'm', name: '남 · 일자형',      bmi: 22.5, ratios: { shoulder: 0.270, chest: 0.560, waist: 0.500, hip: 0.530 }, desc: '직사각 남성 — 어깨·허리 폭 차이가 적은 곧고 단단한 몸통' },
  { id: 'm_vshape',     sex: 'm', name: '남 · 역삼각형',    bmi: 23.0, ratios: { shoulder: 0.292, chest: 0.600, waist: 0.450, hip: 0.525 }, desc: '역삼각 남성 — 넓은 어깨에서 좁은 허리로 떨어지는 V자 상체' },
  { id: 'm_lean_musc',  sex: 'm', name: '남 · 슬림 근육',   bmi: 22.5, ratios: { shoulder: 0.278, chest: 0.575, waist: 0.430, hip: 0.520 }, desc: '슬림 근육 남성 — 마른 편이지만 잔근육과 복근 라인이 선명한 체형' },
  { id: 'm_muscular',   sex: 'm', name: '남 · 근육형',      bmi: 25.0, ratios: { shoulder: 0.295, chest: 0.635, waist: 0.475, hip: 0.550 }, desc: '근육질 남성 — 어깨·가슴·팔다리 근육이 우람하고 군살이 적은 탄탄한 체형' },
  { id: 'm_bodybuild',  sex: 'm', name: '남 · 보디빌더',    bmi: 27.5, ratios: { shoulder: 0.312, chest: 0.695, waist: 0.495, hip: 0.555 }, desc: '보디빌더 남성 — 극단적으로 넓은 어깨·가슴과 상대적으로 잘록한 허리' },
  { id: 'm_broad',      sex: 'm', name: '남 · 다부진형',    bmi: 27.0, ratios: { shoulder: 0.290, chest: 0.650, waist: 0.555, hip: 0.575 }, desc: '다부진(스토키) 남성 — 두껍고 단단한 상체에 굵은 몸통' },
  { id: 'm_dadbod',     sex: 'm', name: '남 · 아빠몸매',    bmi: 25.5, ratios: { shoulder: 0.268, chest: 0.590, waist: 0.560, hip: 0.560 }, desc: '아빠 몸매 — 어느 정도 근육에 배가 나온 편안한 남성 체형' },
  { id: 'm_apple',      sex: 'm', name: '남 · 복부비만',    bmi: 27.5, ratios: { shoulder: 0.268, chest: 0.610, waist: 0.605, hip: 0.575 }, desc: '복부 비만 남성 — 배와 허리가 특히 두꺼운 상복부 중심 체형' },
  { id: 'm_chubby',     sex: 'm', name: '남 · 통통형',      bmi: 28.0, ratios: { shoulder: 0.272, chest: 0.635, waist: 0.585, hip: 0.605 }, desc: '통통한 남성 — 전체적으로 둥글고 두툼하게 살이 붙은 체형' },
  { id: 'm_upper_heavy',sex: 'm', name: '남 · 상체비만',    bmi: 29.0, ratios: { shoulder: 0.288, chest: 0.680, waist: 0.615, hip: 0.590 }, desc: '상체 비만 남성 — 어깨·가슴·복부가 크게 두꺼운 상체 중심 체형' },
  { id: 'm_plus',       sex: 'm', name: '남 · 플러스',      bmi: 32.0, ratios: { shoulder: 0.288, chest: 0.705, waist: 0.660, hip: 0.665 }, desc: '플러스 남성 — 몸 전체가 크고 두꺼운 대형 남성 체형' },
  { id: 'm_obese',      sex: 'm', name: '남 · 초대형',      bmi: 35.0, ratios: { shoulder: 0.298, chest: 0.760, waist: 0.730, hip: 0.705 }, desc: '초대형 남성 — 매우 크고 육중하게 살이 붙은 체형' },
  // ── 여성 (15) ──
  { id: 'f_skinny',     sex: 'f', name: '여 · 마른형',      bmi: 17.0, ratios: { shoulder: 0.215, chest: 0.460, waist: 0.350, hip: 0.520 }, desc: '매우 마른 여성 — 가늘고 굴곡이 적은 여리고 슬렌더한 체형' },
  { id: 'f_slim',       sex: 'f', name: '여 · 슬림',        bmi: 19.0, ratios: { shoulder: 0.225, chest: 0.490, waist: 0.375, hip: 0.550 }, desc: '날씬한 여성 — 가늘면서 은은한 굴곡이 있는 실루엣' },
  { id: 'f_std',        sex: 'f', name: '여 · 표준',        bmi: 21.0, ratios: { shoulder: 0.232, chest: 0.530, waist: 0.420, hip: 0.575 }, desc: '표준 여성 — 균형 잡힌 평균적인 여성 체형' },
  { id: 'f_straight',   sex: 'f', name: '여 · 일자형',      bmi: 21.0, ratios: { shoulder: 0.235, chest: 0.520, waist: 0.460, hip: 0.535 }, desc: '직사각 여성 — 허리 굴곡이 적은 곧은 일자 여성 체형' },
  { id: 'f_hourglass',  sex: 'f', name: '여 · 모래시계',    bmi: 21.5, ratios: { shoulder: 0.235, chest: 0.565, waist: 0.375, hip: 0.605 }, desc: '모래시계 여성 — 어깨·엉덩이가 균형 잡히고 허리가 크게 잘록한 곡선' },
  { id: 'f_glam',       sex: 'f', name: '여 · 글래머',      bmi: 23.0, ratios: { shoulder: 0.238, chest: 0.615, waist: 0.420, hip: 0.600 }, desc: '글래머 여성 — 가슴이 크게 발달하고 허리가 잘록한 볼륨 있는 곡선' },
  { id: 'f_pear',       sex: 'f', name: '여 · 서양배형',    bmi: 22.5, ratios: { shoulder: 0.222, chest: 0.510, waist: 0.430, hip: 0.640 }, desc: '서양배 여성 — 가는 상체에 엉덩이·허벅지가 발달한 하체 중심 곡선' },
  { id: 'f_athletic',   sex: 'f', name: '여 · 애슬레틱',    bmi: 21.5, ratios: { shoulder: 0.245, chest: 0.520, waist: 0.400, hip: 0.560 }, desc: '운동하는 여성 — 탄탄하고 라인이 잡힌 스포티한 체형' },
  { id: 'f_fitness',    sex: 'f', name: '여 · 근육질',      bmi: 23.5, ratios: { shoulder: 0.255, chest: 0.550, waist: 0.415, hip: 0.585 }, desc: '피트니스 여성 — 어깨·복부·다리에 근육이 선명하게 잡힌 탄탄한 여성' },
  { id: 'f_strong_hg',  sex: 'f', name: '여 · 강한 모래시계',bmi: 24.5, ratios: { shoulder: 0.245, chest: 0.620, waist: 0.400, hip: 0.660 }, desc: '강한 모래시계 여성 — 볼륨 있는 가슴·엉덩이에 크게 잘록한 허리' },
  { id: 'f_vol_pear',   sex: 'f', name: '여 · 볼륨 하체',   bmi: 25.5, ratios: { shoulder: 0.230, chest: 0.550, waist: 0.470, hip: 0.680 }, desc: '볼륨 하체 여성 — 허벅지·엉덩이가 풍만하게 발달한 하체 중심 체형' },
  { id: 'f_apple',      sex: 'f', name: '여 · 복부형',      bmi: 25.5, ratios: { shoulder: 0.240, chest: 0.580, waist: 0.550, hip: 0.575 }, desc: '복부형 여성 — 배·허리를 중심으로 살이 붙은 체형' },
  { id: 'f_chubby',     sex: 'f', name: '여 · 통통형',      bmi: 27.0, ratios: { shoulder: 0.242, chest: 0.600, waist: 0.530, hip: 0.635 }, desc: '통통한 여성 — 전체적으로 부드럽고 둥근 곡선의 체형' },
  { id: 'f_curvy_plus', sex: 'f', name: '여 · 곡선 플러스', bmi: 29.0, ratios: { shoulder: 0.250, chest: 0.655, waist: 0.550, hip: 0.690 }, desc: '곡선 플러스 여성 — 풍만하지만 허리 굴곡이 살아있는 큰 체형' },
  { id: 'f_plus',       sex: 'f', name: '여 · 플러스',      bmi: 32.0, ratios: { shoulder: 0.258, chest: 0.685, waist: 0.640, hip: 0.715 }, desc: '플러스 여성 — 가슴·허리·엉덩이가 모두 두꺼운 대형 여성 체형' },
];
let originalModelFile = null;   // 분석 당시 원본 모델 파일(되돌리기용)
let originalModelSpec = null;   // 분석 당시 원본 실측 스냅샷
let selectedBodyPresetId = null;
let reshapedActive = false;     // 재렌더된 모델을 쓰는 중인지
// 재렌더 기록: 원본 + 매 재렌더 결과. { name, dataUrl, spec, file?, active }
let reshapeHistory = [];
let reshapeLoading = false; // 재렌더 진행 중이면 기록 끝에 스피너 빈칸 표시

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const selectedReshapeEngine = () => (document.querySelector('input[name="reshapeEngine"]:checked') || {}).value || 'gpt-image-2-high';

// 체형 비율로 앞모습 실루엣 SVG를 그립니다. 표준 대비 편차를 증폭해 체형 차이가 한눈에 보이게 합니다.
const SILH_STD = { shoulder: 0.245, chest: 0.54, waist: 0.45, hip: 0.56 };
const SILH_AMP = 1.75; // 표준에서의 편차를 이만큼 증폭(실루엣 구분을 뚜렷하게)
function bodySilhouetteSVG(r, sex) {
  // 표준을 고정 반폭(px)으로 두고, 편차를 증폭해 비례 반영.
  const eff = (k) => SILH_STD[k] + (r[k] - SILH_STD[k]) * SILH_AMP;
  const sh = eff('shoulder') / SILH_STD.shoulder * 26;
  const bu = eff('chest') / SILH_STD.chest * 22;
  const wa = eff('waist') / SILH_STD.waist * 17;
  const hi = eff('hip') / SILH_STD.hip * 24;
  const cx = 50;
  const shY = 38, buY = 56, waY = 78, hiY = 96, footY = 146;
  const midWH = (waY + hiY) / 2;
  // 몸통: 어깨→가슴→허리(잘록)→엉덩이 를 부드러운 곡선으로.
  const torso = `M ${cx - sh} ${shY}`
    + ` Q ${cx - bu} ${buY} ${cx - wa} ${waY}`
    + ` Q ${cx - hi} ${midWH} ${cx - hi} ${hiY}`
    + ` L ${cx + hi} ${hiY}`
    + ` Q ${cx + hi} ${midWH} ${cx + wa} ${waY}`
    + ` Q ${cx + bu} ${buY} ${cx + sh} ${shY}`
    + ` Q ${cx} ${shY - 8} ${cx - sh} ${shY} Z`;
  // 다리: 엉덩이폭에서 시작해 발목으로 테이퍼.
  const inner = 3, ankle = Math.max(6, hi * 0.42);
  const legL = `M ${cx - hi} ${hiY - 2} L ${cx - inner} ${hiY - 2} L ${cx - inner - 1} ${footY} L ${cx - ankle - 2} ${footY} Z`;
  const legR = `M ${cx + hi} ${hiY - 2} L ${cx + inner} ${hiY - 2} L ${cx + inner + 1} ${footY} L ${cx + ankle + 2} ${footY} Z`;
  // 팔: 어깨 바깥에서 허리 옆까지 얇게 내려오게(몸통 바깥에 위치).
  const armTop = Math.max(sh, bu) + 1, armBot = Math.max(wa, hi) + 2;
  const armL = `M ${cx - armTop} ${shY + 1} L ${cx - armTop - 6} ${shY + 6} L ${cx - armBot - 4} ${hiY - 4} L ${cx - armBot + 1} ${hiY - 4} Z`;
  const armR = `M ${cx + armTop} ${shY + 1} L ${cx + armTop + 6} ${shY + 6} L ${cx + armBot + 4} ${hiY - 4} L ${cx + armBot - 1} ${hiY - 4} Z`;
  // 여성은 가슴 곡선 표시(스트로크)로 성별을 구분.
  const bust = sex === 'f'
    ? `<g fill="none" stroke="#a7b0bc" stroke-width="1.3" stroke-linecap="round">`
      + `<path d="M ${cx - bu * 0.58} ${buY + 0.5} Q ${cx - bu * 0.30} ${buY + 8} ${cx - 1.5} ${buY + 2.5}"/>`
      + `<path d="M ${cx + bu * 0.58} ${buY + 0.5} Q ${cx + bu * 0.30} ${buY + 8} ${cx + 1.5} ${buY + 2.5}"/></g>`
    : '';
  return `<svg viewBox="0 0 100 152" xmlns="http://www.w3.org/2000/svg"><g fill="#c3cad4">`
    + `<circle cx="${cx}" cy="20" r="11"/><rect x="${cx - 4.5}" y="29" width="9" height="12" rx="3"/>`
    + `<path d="${armL}"/><path d="${armR}"/><path d="${torso}"/><path d="${legL}"/><path d="${legR}"/></g>${bust}</svg>`;
}

// 원본 실측에서 실루엣용 비율을 뽑습니다(없으면 표준값).
function originalRatios() {
  const s = originalModelSpec;
  const h = s && parseFloat(s.height_cm);
  if (!s || !h) return { shoulder: 0.245, chest: 0.54, waist: 0.45, hip: 0.56 };
  return {
    shoulder: (parseFloat(s.shoulder_width_cm) || 0.245 * h) / h,
    chest: (parseFloat(s.chest_cm) || 0.54 * h) / h,
    waist: (parseFloat(s.waist_cm) || 0.45 * h) / h,
    hip: (parseFloat(s.hip_cm) || 0.56 * h) / h,
  };
}

function makeBodyCard(id, name, ratios, selected, sex) {
  const card = document.createElement('div');
  card.className = 'bodyTypeCard' + (selected ? ' selected' : '');
  card.dataset.id = id;
  const svg = document.createElement('div');
  svg.innerHTML = bodySilhouetteSVG(ratios, sex);
  card.appendChild(svg.firstChild);
  const nm = document.createElement('div');
  nm.className = 'btName';
  nm.textContent = name;
  card.appendChild(nm);
  return card;
}

function renderBodyModalGrid() {
  if (!bodyModalGrid) return;
  bodyModalGrid.innerHTML = '';
  const orig = makeBodyCard('original', '분석값(원본)', originalRatios(), selectedBodyPresetId === 'original');
  orig.addEventListener('click', () => { selectOriginalBody(); closeBodyModal(); });
  bodyModalGrid.appendChild(orig);
  for (const p of BODY_PRESETS) {
    const card = makeBodyCard(p.id, p.name, p.ratios, selectedBodyPresetId === p.id, p.sex);
    card.addEventListener('click', () => { applyBodyPreset(p); closeBodyModal(); });
    bodyModalGrid.appendChild(card);
  }
}

function selectedBodyName() {
  if (selectedBodyPresetId === 'custom') return '사용자 지정';
  if (!selectedBodyPresetId || selectedBodyPresetId === 'original') return '분석값(원본)';
  const p = BODY_PRESETS.find((x) => x.id === selectedBodyPresetId);
  return p ? p.name : '분석값(원본)';
}

// 치수를 손으로 수정하면 '사용자 지정'으로 표시하고, 그 치수로 재렌더할 수 있게 합니다.
function onModelMeasurementEdited() {
  if (!modelSpec || !bodyTypeSection || bodyTypeSection.style.display === 'none') return;
  if (selectedBodyPresetId !== 'custom') { selectedBodyPresetId = 'custom'; updateSelectedBodyLabel(); }
  reshapedActive = false;
  if (reshapeBtn) reshapeBtn.disabled = false;
  if (reshapeHint) { reshapeHint.textContent = '치수를 수정했어요. [모델 재렌더]로 이 치수의 모델샷을 만드세요.'; reshapeHint.classList.add('warn'); }
}
function updateSelectedBodyLabel() {
  if (selectedBodyLabel) selectedBodyLabel.textContent = `현재 체형: ${selectedBodyName()}${reshapedActive ? ' · 재렌더됨' : ''}`;
}
function openBodyModal() {
  if (!bodyModal) return;
  renderBodyModalGrid();
  bodyModal.classList.add('show');
}
function closeBodyModal() {
  if (bodyModal) bodyModal.classList.remove('show');
}

// ── 헤어스타일 모달 ──
function makeHairCard(preset, selected) {
  const card = document.createElement('div');
  card.className = 'bodyTypeCard' + (selected ? ' selected' : '');
  const svg = document.createElement('div');
  const attrs = preset ? preset.attrs : { len: 'medium', tex: 'straight', bangs: 'none', tie: 'none' };
  svg.innerHTML = hairIconSVG(attrs, currentHairHex());
  card.appendChild(svg.firstChild);
  const nm = document.createElement('div');
  nm.className = 'btName';
  nm.textContent = preset ? preset.name : '원본 유지';
  card.appendChild(nm);
  return card;
}
function renderHairModalGrid() {
  if (!hairModalGrid) return;
  hairModalGrid.innerHTML = '';
  const keep = makeHairCard(null, !selectedHair);
  keep.addEventListener('click', () => { applyHair(null); closeHairModal(); });
  hairModalGrid.appendChild(keep);
  for (const p of HAIR_PRESETS) {
    const card = makeHairCard(p, selectedHair && selectedHair.id === p.id);
    card.addEventListener('click', () => { applyHair(p); closeHairModal(); });
    hairModalGrid.appendChild(card);
  }
}
function openHairModal() { if (!hairModal) return; renderHairModalGrid(); hairModal.classList.add('show'); }
function closeHairModal() { if (hairModal) hairModal.classList.remove('show'); }
function applyHair(preset) {
  selectedHair = preset;
  updateHairLabel();
  if (preset) enableReshapeForStyle(`헤어를 '${preset.name}'로 바꿔요. [모델 재렌더]를 누르세요.`);
}
function updateHairLabel() {
  if (!hairLabel) return;
  const col = HAIR_COLORS.find((c) => c.id === selectedHairColorId);
  const colTxt = (col && col.id !== 'keep') ? ` · ${col.name}` : '';
  hairLabel.textContent = `헤어: ${selectedHair ? selectedHair.name : '원본 유지'}${colTxt}`;
}
// ── 머리색 스와치 ──
function renderColorSwatches() {
  if (!hairColorRow) return;
  hairColorRow.innerHTML = '';
  for (const c of HAIR_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'colorSwatch' + (selectedHairColorId === c.id ? ' selected' : '') + (c.id === 'keep' ? ' keep' : '');
    sw.title = c.name;
    if (c.hex) sw.style.background = c.hex;
    sw.textContent = c.id === 'keep' ? '유지' : '';
    sw.addEventListener('click', () => selectColor(c));
    hairColorRow.appendChild(sw);
  }
}
function selectColor(c) {
  selectedHairColorId = c.id;
  renderColorSwatches();
  if (hairModal && hairModal.classList.contains('show')) renderHairModalGrid(); // 아이콘 색 갱신
  updateHairLabel();
  if (c.id !== 'keep') enableReshapeForStyle(`머리색을 '${c.name}'로 바꿔요. [모델 재렌더]를 누르세요.`);
}
function enableReshapeForStyle(msg) {
  if (reshapeBtn) reshapeBtn.disabled = false;
  if (reshapeHint) { reshapeHint.textContent = msg; reshapeHint.classList.add('warn'); }
}
// 재렌더 후 헤어/색상 선택은 이미 적용됐으므로 '유지'로 리셋합니다.
function resetHairSelection() {
  selectedHair = null;
  selectedHairColorId = 'keep';
  updateHairLabel();
  renderColorSwatches();
}

// 재렌더 기록 스트립: 원본 + 매 재렌더 결과를 썸네일로 나열. 클릭=크게, [사용]=그 모델로 전환.
function setHistoryActive(idx) {
  reshapeHistory.forEach((h, i) => { h.active = i === idx; });
}
function renderReshapeHistory() {
  const box = document.getElementById('reshapeResult');
  if (!box) return;
  box.innerHTML = '';
  if (!reshapeHistory.length && !reshapeLoading) { box.style.display = 'none'; return; }
  box.style.display = '';
  const label = document.createElement('div');
  label.className = 'reshapeResultLabel';
  label.textContent = `모델 기록 ${reshapeHistory.length}개 — 썸네일 클릭: 크게 보기 · [사용]: 그 모델로 되돌리기 (현재 사용 중은 테두리 강조)`;
  box.appendChild(label);
  const strip = document.createElement('div');
  strip.className = 'reshapeHistStrip';
  reshapeHistory.forEach((h, i) => {
    const cell = document.createElement('div');
    cell.className = 'reshapeHistCell' + (h.active ? ' active' : '');
    const img = document.createElement('img');
    img.src = h.dataUrl;
    img.addEventListener('click', () => openModal(h.dataUrl));
    const cap = document.createElement('div');
    cap.className = 'reshapeHistCap';
    cap.textContent = `${i === 0 ? '원본' : '#' + i} · ${h.name}`;
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'reshapeHistUse';
    use.textContent = h.active ? '사용 중' : '사용';
    use.disabled = !!h.active;
    use.addEventListener('click', () => useHistoryModel(i));
    cell.appendChild(img);
    cell.appendChild(cap);
    cell.appendChild(use);
    strip.appendChild(cell);
  });
  if (reshapeLoading) {
    const cell = document.createElement('div');
    cell.className = 'reshapeHistCell loading';
    const ph = document.createElement('div');
    ph.className = 'reshapeHistLoad';
    ph.appendChild(document.createElement('div')).className = 'spinner';
    const cap = document.createElement('div');
    cap.className = 'reshapeHistCap';
    cap.textContent = '재렌더 중…';
    cell.appendChild(ph);
    cell.appendChild(cap);
    strip.appendChild(cell);
  }
  box.appendChild(strip);
}

// 기록 속 특정 모델을 현재 모델로 전환합니다(그 시점의 실측도 함께 복원).
async function useHistoryModel(idx) {
  const h = reshapeHistory[idx];
  if (!h) return;
  const file = h.file || dataUrlToFile(h.dataUrl, `model-${idx}.png`);
  files.model[0] = file;
  modelSpecImg = await loadImageFromFile(file);
  if (h.spec) modelSpec = JSON.parse(JSON.stringify(h.spec));
  reshapedActive = idx !== 0;
  selectedBodyPresetId = idx === 0 ? 'original' : (h.presetId || 'custom');
  setHistoryActive(idx);
  renderUploadArea();
  renderModelSpec();
  updateSelectedBodyLabel();
  renderReshapeHistory();
  if (reshapeBtn) reshapeBtn.disabled = idx === 0; // 원본이면 재렌더 대기 아님
  if (reshapeHint) { reshapeHint.textContent = idx === 0 ? '원본 모델을 사용 중입니다.' : `#${idx} 모델을 사용 중입니다.`; reshapeHint.classList.remove('warn'); }
  fittingItems = []; lastFitMap = null; renderFittingItems(); refreshButtonStates();
}

// 체형 카드 선택: 키·팔·상체·다리(골격)는 그대로, 어깨/가슴/허리/엉덩이/몸무게만 프리셋으로 교체.
function applyBodyPreset(preset) {
  if (!modelSpec) return;
  const h = parseFloat(modelSpec.height_cm) || 0;
  modelSpec.shoulder_width_cm = round1(preset.ratios.shoulder * h);
  modelSpec.chest_cm = round1(preset.ratios.chest * h);
  modelSpec.waist_cm = round1(preset.ratios.waist * h);
  modelSpec.hip_cm = round1(preset.ratios.hip * h);
  if (h > 0) modelSpec.weight_kg = round1(preset.bmi * (h / 100) * (h / 100));
  selectedBodyPresetId = preset.id;
  reshapedActive = false;
  renderModelSpec();
  updateSelectedBodyLabel();
  if (reshapeBtn) reshapeBtn.disabled = false;
  if (reshapeHint) { reshapeHint.textContent = '치수를 바꿨어요. [모델 재렌더]를 눌러 이 체형의 모델샷을 만드세요.'; reshapeHint.classList.add('warn'); }
  // 모델이 바뀌면 이전 핏 지시사항은 더 이상 맞지 않으므로 비웁니다.
  fittingItems = []; lastFitMap = null; renderFittingItems();
  refreshButtonStates();
}

// 원본 카드: 실측·모델 이미지를 분석 당시로 되돌립니다.
function selectOriginalBody() {
  if (!originalModelSpec) return;
  // 기록의 0번(원본)으로 전환. 기록이 있으면 그 경로로 통일.
  if (reshapeHistory.length) { useHistoryModel(0); return; }
  modelSpec = JSON.parse(JSON.stringify(originalModelSpec));
  selectedBodyPresetId = 'original';
  reshapedActive = false;
  if (originalModelFile) {
    files.model[0] = originalModelFile;
    renderUploadArea();
    loadImageFromFile(originalModelFile).then((im) => { modelSpecImg = im; renderModelSpec(); });
  }
  if (reshapeBtn) reshapeBtn.disabled = true;
  if (reshapeHint) { reshapeHint.textContent = '원본 분석값으로 되돌렸어요.'; reshapeHint.classList.remove('warn'); }
  fittingItems = []; lastFitMap = null;
  renderModelSpec(); updateSelectedBodyLabel(); renderFittingItems(); refreshButtonStates();
}

// dataURL → File (재렌더 결과 이미지를 모델 파일로 교체하기 위해).
function dataUrlToFile(dataUrl, name) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:(.*?);/) || [, 'image/png'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

// [선택 체형으로 모델 재렌더]: 서버가 그 체형으로 모델샷을 다시 생성 → 모델 입력을 교체.
// 재렌더가 '먹지 않는' 주된 원인: 절대 치수(cm)만으로는 이미지 모델이 사진 속 인물의 현재 치수를
// 알 수 없어 무엇을 바꿀지 약하게 인식합니다. 그래서 소스 이미지 대비 '무엇을·어느 방향으로·얼마나'
// 바꿀지 방향+강도 지시문(영문)을 만들어 프롬프트의 최우선 지시로 실어줍니다.
function buildBodyChangeInstruction(base, target) {
  if (!base || !target) return '';
  const mag = (pct) => {
    const a = Math.abs(pct);
    if (a < 2) return null;      // 사실상 변화 없음 → 언급하지 않음
    if (a < 5) return 'slightly';
    if (a < 12) return 'noticeably';
    return 'dramatically';
  };
  const parts = [];
  const push = (key, upWord, downWord, label) => {
    const b = parseFloat(base[key]);
    const t = parseFloat(target[key]);
    if (!isFinite(b) || !isFinite(t) || b <= 0) return;
    const m = mag(((t - b) / b) * 100);
    if (!m) return;
    parts.push(`Make the ${label} ${m} ${t > b ? upWord : downWord} than in the source photo (about ${round1(b)} → ${round1(t)}cm).`);
  };
  push('shoulder_width_cm', 'broader', 'narrower', 'SHOULDERS');
  push('chest_cm', 'fuller and rounder', 'flatter and slimmer', 'CHEST/BUST');
  push('waist_cm', 'fuller and rounder', 'slimmer and more cinched', 'WAIST');
  push('hip_cm', 'fuller and wider', 'slimmer and narrower', 'HIPS');
  const bw = parseFloat(base.weight_kg);
  const tw = parseFloat(target.weight_kg);
  if (isFinite(bw) && isFinite(tw) && bw > 0) {
    const m = mag(((tw - bw) / bw) * 100);
    if (m) parts.push(`Overall, make the build ${m} ${tw > bw ? 'heavier, softer and more voluminous' : 'leaner and lighter'} than in the source photo (about ${round1(bw)} → ${round1(tw)}kg).`);
  }
  if (!parts.length) return '';
  return 'Apply each of these changes clearly and visibly:\n- ' + parts.join('\n- ');
}

if (reshapeBtn) reshapeBtn.addEventListener('click', async () => {
  if (!files.model.length || !modelSpec) {
    setStatus('먼저 모델 체형 분석을 완료하세요.'); return;
  }
  // 프리셋을 골랐으면 그 설명을, 손으로 치수만 바꿨으면(custom/원본) 치수 기반 설명을 씁니다.
  const preset = BODY_PRESETS.find((p) => p.id === selectedBodyPresetId);
  const bodyDesc = preset ? preset.desc : '아래 목표 치수(키 대비 어깨·가슴·허리·엉덩이 비율)에 자연스럽게 맞는 체형';
  const presetName = preset ? preset.name : '사용자 지정 치수';
  // 헤어/색상(선택된 경우만)
  const hairDesc = selectedHair ? selectedHair.desc : '';
  const colorObj = HAIR_COLORS.find((c) => c.id === selectedHairColorId);
  const hairColorEn = (colorObj && colorObj.id !== 'keep') ? colorObj.en : '';
  const styleBits = [presetName];
  if (selectedHair) styleBits.push(selectedHair.name);
  if (hairColorEn) styleBits.push(colorObj.name);
  const styleLabel = styleBits.join(' · ');
  // 방향+강도 지시문: 현재 소스 이미지(활성 기록)의 실측을 기준으로 지금 치수와의 차이를 계산.
  const activeHist = reshapeHistory.find((h) => h.active);
  const baseSpec = (activeHist && activeHist.spec) ? activeHist.spec : originalModelSpec;
  const bodyChangeInstruction = buildBodyChangeInstruction(baseSpec, modelSpec);
  reshapeBtn.disabled = true;
  reshapeLoading = true; renderReshapeHistory(); // 기록 끝에 빙빙 도는 빈칸 표시
  const timer = startTimer(reshapeElapsed, '모델 재렌더');
  setStatus(`'${styleLabel}'(으)로 모델샷을 재렌더하는 중... (1~2분 걸릴 수 있어요)`);
  try {
    const modelDataUrl = await toUploadDataUrl(files.model[0]);
    const target = [
      `- 키: ${modelSpec.height_cm}cm (유지)`,
      `- 어깨너비: ${modelSpec.shoulder_width_cm}cm`,
      `- 가슴둘레: ${modelSpec.chest_cm}cm`,
      `- 허리둘레: ${modelSpec.waist_cm}cm`,
      `- 엉덩이둘레: ${modelSpec.hip_cm}cm`,
      `- 몸무게: ${modelSpec.weight_kg}kg`,
    ].join('\n');
    const res = await fetch('/api/v27/reshape-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelDataUrl, bodyTypeDescription: bodyDesc, targetMeasurements: target, bodyChangeInstruction, hairDescription: hairDesc, hairColor: hairColorEn, engine: selectedReshapeEngine() }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const file = dataUrlToFile(data.resultDataUrl, 'reshaped-model.png');
    files.model[0] = file;
    modelSpecImg = await loadImageFromFile(file);
    reshapedActive = true;
    // 재렌더 결과를 기록에 추가하고 그것을 현재 사용 모델로 표시.
    setHistoryActive(-1);
    reshapeHistory.push({ name: styleLabel, dataUrl: data.resultDataUrl, spec: JSON.parse(JSON.stringify(modelSpec)), presetId: selectedBodyPresetId, active: true });
    reshapeLoading = false;
    resetHairSelection(); // 헤어/색상은 이미 반영됨 → 유지로 리셋
    renderUploadArea();
    renderModelSpec();
    updateSelectedBodyLabel();
    renderReshapeHistory();
    fittingItems = []; lastFitMap = null; renderFittingItems();
    timer.stop(true);
    if (reshapeHint) { reshapeHint.textContent = `'${styleLabel}'(으)로 재렌더했어요. 기록에서 이전 모델로 되돌리거나, 체형·헤어를 더 바꿔 다시 재렌더할 수 있어요.`; reshapeHint.classList.remove('warn'); }
    setStatus(`'${styleLabel}'(으)로 모델 재렌더 완료. 아래 기록에서 확인하고 [옷 분석]으로 진행하세요.`);
    reshapeBtn.disabled = false;
  } catch (err) {
    console.error(err); timer.stop(false);
    reshapeLoading = false; renderReshapeHistory(); // 스피너 빈칸 제거
    reshapeBtn.disabled = false;
    setStatus(`모델 재렌더 실패: ${err.message || err}`);
  } finally { refreshButtonStates(); }
});

// ===== v2.7 헤어스타일 + 색상 =====
const HAIR_COLORS = [
  { id: 'keep',       name: '유지',        hex: null,      en: '' },
  { id: 'black',      name: '블랙',        hex: '#2b2622', en: 'natural black' },
  { id: 'darkbrown',  name: '다크브라운',  hex: '#4a3526', en: 'dark brown' },
  { id: 'brown',      name: '브라운',      hex: '#6b4a30', en: 'medium brown' },
  { id: 'lightbrown', name: '라이트브라운',hex: '#8c6239', en: 'light brown' },
  { id: 'ash',        name: '애쉬',        hex: '#6d6157', en: 'ash brown' },
  { id: 'blonde',     name: '블론드',      hex: '#c9a15e', en: 'golden blonde' },
  { id: 'platinum',   name: '플래티넘',    hex: '#d8cdb4', en: 'platinum blonde' },
  { id: 'auburn',     name: '애번',        hex: '#7a3b28', en: 'auburn reddish-brown' },
  { id: 'red',        name: '레드',        hex: '#a23a2a', en: 'vivid red' },
  { id: 'wine',       name: '와인',        hex: '#5a2233', en: 'wine burgundy' },
  { id: 'pink',       name: '핑크',        hex: '#d98aa8', en: 'pastel pink' },
  { id: 'blue',       name: '블루',        hex: '#3f5a8a', en: 'blue' },
  { id: 'gray',       name: '그레이',      hex: '#9a9a9a', en: 'silver gray' },
];
// attrs: len(buzz|pixie|short|medium|long) · tex(straight|wavy|curly) · bangs(none|full|side|center|seethrough) · tie(none|ponytail|bun|half|manbun|slick)
const HAIR_PRESETS = [
  // 여성 18
  { id: 'f_bob_straight', sex: 'f', name: '여 · 단발',        attrs: { len: 'short',  tex: 'straight', bangs: 'none',       tie: 'none' },     desc: 'a chin-length straight bob, no bangs' },
  { id: 'f_bob_bangs',    sex: 'f', name: '여 · 단발 뱅',     attrs: { len: 'short',  tex: 'straight', bangs: 'full',       tie: 'none' },     desc: 'a chin-length straight bob with full straight bangs' },
  { id: 'f_pixie',        sex: 'f', name: '여 · 픽시컷',      attrs: { len: 'pixie',  tex: 'straight', bangs: 'side',       tie: 'none' },     desc: 'a short pixie cut swept to the side' },
  { id: 'f_med_straight', sex: 'f', name: '여 · 미디엄',      attrs: { len: 'medium', tex: 'straight', bangs: 'center',     tie: 'none' },     desc: 'medium-length straight hair to the shoulders with a center part' },
  { id: 'f_med_wave',     sex: 'f', name: '여 · 미디엄 웨이브',attrs: { len: 'medium', tex: 'wavy',     bangs: 'none',       tie: 'none' },     desc: 'medium-length soft wavy hair to the shoulders' },
  { id: 'f_med_bangs',    sex: 'f', name: '여 · 미디엄 뱅',   attrs: { len: 'medium', tex: 'wavy',     bangs: 'full',       tie: 'none' },     desc: 'medium wavy hair with full bangs' },
  { id: 'f_long_straight',sex: 'f', name: '여 · 롱 스트레이트',attrs: { len: 'long',   tex: 'straight', bangs: 'center',     tie: 'none' },     desc: 'long straight hair past the chest with a center part' },
  { id: 'f_long_wave',    sex: 'f', name: '여 · 롱 웨이브',   attrs: { len: 'long',   tex: 'wavy',     bangs: 'side',       tie: 'none' },     desc: 'long wavy hair past the chest, side part' },
  { id: 'f_long_curly',   sex: 'f', name: '여 · 롱 컬',       attrs: { len: 'long',   tex: 'curly',    bangs: 'none',       tie: 'none' },     desc: 'long voluminous curly hair' },
  { id: 'f_long_bangs',   sex: 'f', name: '여 · 롱 뱅',       attrs: { len: 'long',   tex: 'straight', bangs: 'full',       tie: 'none' },     desc: 'long straight hair with full straight bangs' },
  { id: 'f_seethrough',   sex: 'f', name: '여 · 시스루뱅',    attrs: { len: 'long',   tex: 'straight', bangs: 'seethrough', tie: 'none' },     desc: 'long straight hair with wispy see-through bangs' },
  { id: 'f_sidebang',     sex: 'f', name: '여 · 사이드뱅',    attrs: { len: 'long',   tex: 'wavy',     bangs: 'side',       tie: 'none' },     desc: 'long hair with long side-swept bangs and soft waves' },
  { id: 'f_centerpart',   sex: 'f', name: '여 · 가르마 롱',   attrs: { len: 'long',   tex: 'straight', bangs: 'center',     tie: 'none' },     desc: 'long sleek straight hair with a clean center part' },
  { id: 'f_ponytail',     sex: 'f', name: '여 · 포니테일',    attrs: { len: 'long',   tex: 'straight', bangs: 'none',       tie: 'ponytail' }, desc: 'hair pulled back into a high ponytail' },
  { id: 'f_highbun',      sex: 'f', name: '여 · 하이번',      attrs: { len: 'long',   tex: 'straight', bangs: 'none',       tie: 'bun' },      desc: 'hair in a neat high bun updo' },
  { id: 'f_lowbun',       sex: 'f', name: '여 · 로우번',      attrs: { len: 'long',   tex: 'straight', bangs: 'center',     tie: 'bun' },      desc: 'hair in a low bun at the nape of the neck' },
  { id: 'f_halfup',       sex: 'f', name: '여 · 반묶음',      attrs: { len: 'long',   tex: 'wavy',     bangs: 'none',       tie: 'half' },     desc: 'a half-up half-down hairstyle with waves' },
  { id: 'f_short_wave',   sex: 'f', name: '여 · 숏 웨이브',   attrs: { len: 'short',  tex: 'wavy',     bangs: 'side',       tie: 'none' },     desc: 'a short wavy bob swept to the side' },
  // 남성 12
  { id: 'm_crew',      sex: 'm', name: '남 · 크루컷',    attrs: { len: 'pixie',  tex: 'straight', bangs: 'none', tie: 'none' },   desc: 'a short neat crew cut' },
  { id: 'm_sidepart',  sex: 'm', name: '남 · 사이드파트', attrs: { len: 'short',  tex: 'straight', bangs: 'side', tie: 'none' },   desc: 'a short side-part haircut, neatly combed' },
  { id: 'm_twoblock',  sex: 'm', name: '남 · 투블럭',    attrs: { len: 'short',  tex: 'straight', bangs: 'full', tie: 'none' },   desc: 'a two-block undercut, fuller on top with short sides' },
  { id: 'm_slickback', sex: 'm', name: '남 · 슬릭백',    attrs: { len: 'short',  tex: 'straight', bangs: 'none', tie: 'slick' },  desc: 'a slicked-back pomade hairstyle' },
  { id: 'm_fringe',    sex: 'm', name: '남 · 프린지',    attrs: { len: 'medium', tex: 'straight', bangs: 'full', tie: 'none' },   desc: 'a medium fringe hairstyle with hair over the forehead' },
  { id: 'm_med_wave',  sex: 'm', name: '남 · 미디엄 웨이브',attrs: { len: 'medium', tex: 'wavy',   bangs: 'side', tie: 'none' },   desc: 'medium wavy hair, casually swept to the side' },
  { id: 'm_curly',     sex: 'm', name: '남 · 곱슬 숏',   attrs: { len: 'short',  tex: 'curly',    bangs: 'none', tie: 'none' },   desc: 'short curly hair' },
  { id: 'm_long',      sex: 'm', name: '남 · 롱',        attrs: { len: 'long',   tex: 'straight', bangs: 'center', tie: 'none' }, desc: 'long straight hair past the shoulders on a man' },
  { id: 'm_manbun',    sex: 'm', name: '남 · 맨번',      attrs: { len: 'medium', tex: 'straight', bangs: 'none', tie: 'manbun' },desc: 'hair tied up into a man bun' },
  { id: 'm_buzz',      sex: 'm', name: '남 · 버즈컷',    attrs: { len: 'buzz',   tex: 'straight', bangs: 'none', tie: 'none' },   desc: 'a very short buzz cut' },
  { id: 'm_perm',      sex: 'm', name: '남 · 펌',        attrs: { len: 'medium', tex: 'curly',    bangs: 'full', tie: 'none' },   desc: 'a permed curly hairstyle with volume' },
  { id: 'm_wolf',      sex: 'm', name: '남 · 울프컷',    attrs: { len: 'medium', tex: 'wavy',     bangs: 'full', tie: 'none' },   desc: 'a layered, textured wolf cut' },
];
let selectedHair = null;        // 프리셋 객체 or null(유지)
let selectedHairColorId = 'keep';

function shadeHex(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  const r = cl((n >> 16) + amt), g = cl(((n >> 8) & 255) + amt), b = cl((n & 255) + amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function currentHairHex() {
  const c = HAIR_COLORS.find((x) => x.id === selectedHairColorId);
  return (c && c.hex) || '#6b4a30';
}
// 텍스처가 있는 세로 가장자리(옆머리)를 path 조각으로. side=+1(오른쪽)/-1(왼쪽)
function hairEdge(x1, y1, x2, y2, tex, side) {
  if (tex === 'straight') return `L ${x2} ${y2}`;
  const n = Math.max(3, Math.round(Math.abs(y2 - y1) / 11));
  const amp = tex === 'curly' ? 4.5 : 3;
  const freq = tex === 'curly' ? 3.5 : 1.8;
  let d = '';
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const y = y1 + (y2 - y1) * t;
    const x = x1 + (x2 - x1) * t + Math.sin(t * Math.PI * freq) * amp * side;
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}
// 얼굴 + 헤어(속성) 아이콘. hairHex로 색 반영.
function hairIconSVG(a, hairHex) {
  const hair = hairHex || '#6b4a30';
  const dark = shadeHex(hair, -24);
  const skin = '#f0d9c9';
  const cx = 50;
  const halfW = ({ buzz: 20, pixie: 22, short: 25, medium: 28, long: 30 }[a.len] || 25);
  const endY = ({ buzz: 41, pixie: 60, short: 74, medium: 100, long: 126 }[a.len] || 74);
  const crownTopY = (a.tie === 'bun' || a.tie === 'manbun') ? 15 : 20;
  const templeY = 42;
  // 뒤/옆머리
  let backHair = '';
  if (a.len !== 'buzz' && a.len !== 'pixie') {
    const rt = cx + halfW, lt = cx - halfW, rb = cx + halfW * 0.8, lb = cx - halfW * 0.8;
    backHair = `<path fill="${dark}" d="M ${lt} ${templeY} Q ${cx} ${crownTopY - 2} ${rt} ${templeY}`
      + ` ${hairEdge(rt, templeY, rb, endY, a.tex, 1)}`
      + ` Q ${cx} ${endY + 8} ${lb} ${endY}`
      + ` ${hairEdge(lb, endY, lt, templeY, a.tex, -1)} Z"/>`;
  } else if (a.len === 'pixie') {
    backHair = `<path fill="${dark}" d="M ${cx - halfW} ${templeY} Q ${cx} ${crownTopY - 1} ${cx + halfW} ${templeY} Q ${cx + halfW - 2} ${templeY + 16} ${cx + halfW - 7} ${templeY + 20} L ${cx - halfW + 7} ${templeY + 20} Q ${cx - halfW + 2} ${templeY + 16} ${cx - halfW} ${templeY} Z"/>`;
  }
  // 얼굴
  const face = `<g><ellipse cx="${cx}" cy="55" rx="18.5" ry="24" fill="${skin}"/>`
    + `<ellipse cx="30.5" cy="57" rx="3" ry="4.5" fill="${skin}"/><ellipse cx="69.5" cy="57" rx="3" ry="4.5" fill="${skin}"/>`
    + `<g fill="#7a6a60"><ellipse cx="43" cy="54" rx="1.7" ry="2.1"/><ellipse cx="57" cy="54" rx="1.7" ry="2.1"/></g>`
    + `<path d="M 46 65 Q 50 67.5 54 65" fill="none" stroke="#c98d86" stroke-width="1.4" stroke-linecap="round"/></g>`;
  // 크라운(두상 덮개)
  const scalp = `<path fill="${hair}" d="M ${cx - halfW} ${templeY} Q ${cx} ${crownTopY} ${cx + halfW} ${templeY} Q ${cx} ${templeY + 7} ${cx - halfW} ${templeY} Z"/>`;
  // 앞머리
  const foreY = 40;
  let bangs = '';
  if (a.bangs === 'full') bangs = `<path fill="${hair}" d="M ${cx - halfW + 3} ${templeY} Q ${cx} ${foreY - 2} ${cx + halfW - 3} ${templeY} Q ${cx + halfW - 6} ${foreY + 9} ${cx} ${foreY + 11} Q ${cx - halfW + 6} ${foreY + 9} ${cx - halfW + 3} ${templeY} Z"/>`;
  else if (a.bangs === 'seethrough') bangs = `<path fill="${hair}" opacity="0.82" d="M ${cx - halfW + 4} ${templeY} Q ${cx} ${foreY} ${cx + halfW - 4} ${templeY} Q ${cx + 5} ${foreY + 7} ${cx} ${foreY + 8} Q ${cx - 5} ${foreY + 7} ${cx - halfW + 4} ${templeY} Z"/>`;
  else if (a.bangs === 'side') bangs = `<path fill="${hair}" d="M ${cx - halfW + 3} ${templeY} Q ${cx - 2} ${foreY - 2} ${cx + halfW - 3} ${templeY} Q ${cx + halfW - 6} ${foreY + 11} ${cx + 6} ${foreY + 7} Q ${cx - 4} ${foreY + 4} ${cx - halfW + 3} ${templeY} Z"/>`;
  else if (a.bangs === 'center') bangs = `<path fill="${hair}" d="M ${cx} ${foreY - 1} Q ${cx - halfW + 2} ${foreY - 3} ${cx - halfW + 3} ${templeY + 2} Q ${cx - 6} ${foreY + 3} ${cx} ${foreY + 1} Q ${cx + 6} ${foreY + 3} ${cx + halfW - 3} ${templeY + 2} Q ${cx + halfW - 2} ${foreY - 3} ${cx} ${foreY - 1} Z"/>`;
  // 묶음
  let tie = '';
  if (a.tie === 'bun' || a.tie === 'manbun') tie = `<circle cx="${cx}" cy="${crownTopY - 4}" r="8" fill="${hair}"/>`;
  else if (a.tie === 'ponytail') tie = `<path fill="${dark}" d="M ${cx + halfW - 5} ${templeY + 3} q 15 6 10 ${Math.round((endY - templeY) * 0.7)} q -5 9 -13 5 q 8 -20 3 -35 Z"/>`;
  else if (a.tie === 'half') tie = `<circle cx="${cx}" cy="${templeY + 1}" r="4" fill="${dark}"/>`;
  return `<svg viewBox="0 0 100 128" xmlns="http://www.w3.org/2000/svg">${backHair}${face}${scalp}${bangs}${tie}</svg>`;
}

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
        no.textContent = `${i + 1}`;
        // 옷 슬롯은 종류가 섞이므로 '안/밖'을 단정하지 않고 업로드 순서만 표시합니다.
        // (실제 겹 순서는 같은 종류끼리 카드 제목의 L1/L2로 표시됩니다.)
        no.title = slot.key === 'garment' ? '업로드 순서 (같은 종류끼리 안→밖)' : (i === 0 ? '가장 안쪽' : i === list.length - 1 ? '가장 바깥' : '중간');
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
        // 대표사진을 갈아끼우면 이전 옷의 추가 뷰는 더 이상 같은 옷이 아니므로 비웁니다.
        if (slot.key === 'garment') garmentViews[i] = [];
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
      del.addEventListener('click', () => removeUploadedAt(slot.key, i));
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

modalOverlay.addEventListener('click', () => modalOverlay.classList.remove('show'));
function openModal(src) {
  if (!src) return;
  modalImg.src = src;
  modalOverlay.classList.add('show');
}

// 합성에 필요한 최소 구성: 모델 1장 + 옷 1장 이상.
function requiredImagesPresent() {
  return files.model.length > 0 && files.garment.length > 0;
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

  if (modelSpecImg) {
    // 화살표는 체크됐을 때만. 기본은 꺼짐(사진만 표시). 옷 카드의 화살표 토글과 동일한 동작.
    const modelArrowsOn = showModelArrowsCheck && showModelArrowsCheck.checked;
    const lines = modelArrowsOn ? (modelSpec.lines || []) : [];
    const overlay = document.createElement('canvas');
    overlay.className = 'specOverlay';
    const drawn = renderOverlayCanvas(modelSpecImg, lines, 560);
    overlay.width = drawn.width;
    overlay.height = drawn.height;
    overlay.getContext('2d').drawImage(drawn, 0, 0);
    overlay.addEventListener('click', () => {
      openModal(renderOverlayCanvas(modelSpecImg, lines, 1100).toDataURL('image/png'));
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
    value.addEventListener('input', () => { modelSpec[field.key] = parseFloat(value.value); onModelMeasurementEdited(); });
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
if (showModelArrowsCheck) showModelArrowsCheck.addEventListener('change', renderModelSpec);

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
// 카드 헤더의 삭제(X) 버튼. 분석 전/후 모두 이 항목만 지웁니다.
function makeCardDeleteBtn(ref, name) {
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'cardDelBtn';
  x.textContent = '×';
  x.title = '이 항목 삭제';
  x.addEventListener('click', (e) => {
    e.stopPropagation(); // 제목 클릭(접기)과 분리
    removeUploadedAt(ref.key, ref.index);
  });
  return x;
}

function renderPendingBox(container, file, title, kind, ref) {
  container.innerHTML = '';
  container.classList.add('specBoxPending');

  const head = document.createElement('div');
  head.className = 'instrGroupTitle specBoxHead';
  const titleText = document.createElement('span');
  titleText.textContent = title;
  titleText.style.flex = '1 1 auto';
  head.appendChild(titleText);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reanalyzeBtn';
  btn.textContent = '분석하기';
  btn.title = '이 사진만 분석합니다 (다른 항목은 그대로)';
  btn.addEventListener('click', () => reanalyzeOne(kind, ref.key, ref.index, btn));
  head.appendChild(btn);
  head.appendChild(makeCardDeleteBtn(ref));
  container.appendChild(head);

  const img = document.createElement('img');
  img.className = 'pendingThumb';
  img.src = thumbUrl(file);
  img.addEventListener('click', () => openModal(img.src));
  // 분석 전 옷 카드도 드래그해 다른 옷과 합칠 수 있게 합니다(뷰로 들어감).
  if (kind === 'garment' && ref) makeDraggablePhoto(img, { kind: 'garment', gi: ref.index });
  container.appendChild(img);

  const note = document.createElement('div');
  note.className = 'pendingNote';
  note.textContent = '아직 분석하지 않은 사진입니다. [분석하기]를 누르거나 위의 [옷 분석]을 누르세요.';
  container.appendChild(note);
}

// 같은 옷의 추가 뷰(뒤/옆) 썸네일 + [뷰 추가] 버튼. 대표사진 아래에 붙습니다.
function renderGarmentViews(colLeft, gi) {
  const wrap = document.createElement('div');
  wrap.className = 'viewsWrap';
  const label = document.createElement('div');
  label.className = 'viewsLabel';
  const views = garmentViews[gi] || (garmentViews[gi] = []);
  label.textContent = `다른 각도 (뒤·옆) ${views.length}/${MAX_VIEWS}`;
  wrap.appendChild(label);

  const strip = document.createElement('div');
  strip.className = 'viewsStrip';
  views.forEach((v, k) => {
    const cell = document.createElement('div');
    cell.className = 'viewThumb';
    const im = document.createElement('img');
    // loadImageFromFile은 로드 후 object URL을 폐기하므로 v.img.src는 무효합니다.
    // 썸네일은 캐시되는 thumbUrl(파일)로 그립니다.
    im.src = thumbUrl(v.file);
    im.addEventListener('click', () => openModal(im.src));
    // 이 뷰를 드래그해 다른 옷 카드로 놓으면 그 옷으로 이동, '별도 옷' 존으로 놓으면 분리됩니다.
    makeDraggablePhoto(im, { kind: 'view', gi, k });
    cell.appendChild(im);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.title = '이 뷰 삭제';
    del.addEventListener('click', () => { views.splice(k, 1); renderSpecs(); });
    cell.appendChild(del);
    // [분리] 이 뷰를 별도 옷 카드로 빼냅니다(같은 옷으로 잘못 묶였을 때 교정).
    const split = document.createElement('button');
    split.type = 'button';
    split.className = 'viewSplit';
    split.textContent = '분리';
    split.title = '이 사진을 별도의 옷으로 분리합니다';
    split.addEventListener('click', () => splitViewToGarment(gi, k));
    cell.appendChild(split);
    strip.appendChild(cell);
  });
  if (views.length < MAX_VIEWS) {
    const add = document.createElement('label');
    add.className = 'viewAdd';
    add.title = '같은 옷의 뒤·옆 사진을 추가합니다 (측정에는 안 쓰이고 그림 참고용)';
    add.textContent = '+ 뷰';
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.addEventListener('change', async (e) => {
      const picked = [...e.target.files];
      const room = MAX_VIEWS - views.length;
      for (const file of picked.slice(0, room)) {
        views.push({ file, img: await loadImageFromFile(file) });
      }
      renderSpecs();
    });
    add.appendChild(inp);
    strip.appendChild(add);
  }
  wrap.appendChild(strip);
  colLeft.appendChild(wrap);
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
  titleText.style.flex = '1 1 auto'; // 제목이 남는 폭을 채워, 뒤의 액션 버튼들을 오른쪽으로 밈
  titleText.style.minWidth = '0';
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
  // 겹 순서 조정: 같은 종류 옷이 2벌 이상일 때만, 카드에서 안쪽↔바깥으로 옮깁니다.
  if (!isWorn && ref) {
    const innerJ = sameCategoryNeighbor(ref.index, -1);
    const outerJ = sameCategoryNeighbor(ref.index, +1);
    if (innerJ >= 0 || outerJ >= 0) {
      const mkMove = (label, dir, enabled, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'layerMoveBtn';
        b.textContent = label;
        b.title = title;
        b.disabled = !enabled;
        b.addEventListener('click', (e) => { e.stopPropagation(); moveGarmentLayer(ref.index, dir); });
        return b;
      };
      groupTitle.appendChild(mkMove('◀ 안쪽', -1, innerJ >= 0, '같은 종류 안에서 더 안쪽(이너)으로'));
      groupTitle.appendChild(mkMove('겉 ▶', +1, outerJ >= 0, '같은 종류 안에서 더 바깥(겉)으로'));
    }
  }
  // [합치기] 이 옷을 다른 옷의 뷰(다른 각도)로 합칩니다 — 그룹핑이 같은 옷을 따로 잡았을 때 교정.
  if (!isWorn && ref && files.garment.length > 1) {
    const mergeSel = document.createElement('select');
    mergeSel.className = 'mergeSelect';
    mergeSel.title = '이 옷을 다른 옷의 뷰(뒤·옆 각도)로 합칩니다';
    const opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = '다른 옷과 합치기…';
    mergeSel.appendChild(opt0);
    files.garment.forEach((_, j) => {
      if (j === ref.index) return;
      const o = document.createElement('option');
      o.value = String(j);
      o.textContent = `→ ${garmentTitleAt(j)}의 뷰로`;
      mergeSel.appendChild(o);
    });
    mergeSel.addEventListener('click', (e) => e.stopPropagation()); // 제목 클릭(접기) 방지
    mergeSel.addEventListener('change', (e) => {
      e.stopPropagation();
      const t = parseInt(mergeSel.value, 10);
      if (Number.isInteger(t)) mergeGarmentInto(ref.index, t);
    });
    groupTitle.appendChild(mergeSel);
  }
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
    groupTitle.appendChild(makeCardDeleteBtn(ref, spec.garment_type));
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

  // 옷 카드: [종류·옷종류 → 사진 → 뷰 → 설명(접기) → 치수(접기)] 한 열로 세로 배치.
  // 액세서리/신발: 기존 2단(사진 왼쪽 | 정보 오른쪽) 유지.
  const bodyWrap = document.createElement('div');
  let colLeft, colRight;        // 액세서리/신발용 2단
  let gTop, gPhoto, gViews, gDesc, gMeas; // 옷용 세로 슬롯
  if (isWorn) {
    bodyWrap.className = 'specBody';
    colLeft = document.createElement('div'); colLeft.className = 'specColLeft';
    colRight = document.createElement('div'); colRight.className = 'specColRight';
    bodyWrap.appendChild(colLeft); bodyWrap.appendChild(colRight);
  } else {
    bodyWrap.className = 'specBodyCol';
    gTop = document.createElement('div');
    gPhoto = document.createElement('div');
    gViews = document.createElement('div');
    gDesc = document.createElement('div');
    gMeas = document.createElement('div');
    bodyWrap.append(gTop, gPhoto, gViews, gDesc, gMeas);
  }
  container.appendChild(bodyWrap);

  // 종류 판정 결과 + 수정 드롭다운. AI가 크롭상의↔미니원피스 등을 오판할 수 있어, 사용자가
  // 여기서 바꾸면 그 종류를 강제로 다시 분석합니다(종류에 따라 실측 항목이 달라지므로).
  if (!isWorn && ref) {
    const catRow = document.createElement('div');
    catRow.className = 'catRow';
    const catLabel = document.createElement('span');
    catLabel.className = 'catLabel';
    catLabel.textContent = 'AI 판정 종류';
    const sel = document.createElement('select');
    sel.className = 'catSelect';
    for (const c of ['top', 'bottom', 'dress', 'set']) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = CATEGORY_LABEL[c];
      if ((entry.category || 'top') === c) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      entry.category = sel.value;
      reanalyzeOne('garment', ref.key, ref.index, sel, sel.value);
    });
    catRow.appendChild(catLabel);
    catRow.appendChild(sel);
    gTop.appendChild(catRow);
  }

  const includeWrap = document.createElement('label');
  includeWrap.className = 'descInclude';
  const includeCheck = document.createElement('input');
  includeCheck.type = 'checkbox';
  includeCheck.checked = !!entry.include;
  includeCheck.addEventListener('change', () => { entry.include = includeCheck.checked; });
  includeWrap.appendChild(includeCheck);
  includeWrap.appendChild(document.createTextNode(isWorn ? ' 설명을 최종 프롬프트에 포함하기' : ' 옷 종류/설명을 최종 프롬프트에 포함하기'));
  // 옷은 설명 섹션(gDesc) 안에, 액세서리는 오른쪽 열에 둡니다.
  (isWorn ? colRight : gDesc).appendChild(includeWrap);

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
  (isWorn ? colRight : gTop).appendChild(typeWrap);

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
    // 사용자가 드래그로 칸을 늘리면 그 높이를 기억해, 이후 타이핑에도 다시 줄이지 않습니다.
    ta.addEventListener('mouseup', () => {
      if (Math.abs(ta.offsetHeight - Number(ta.dataset.autoH || 0)) > 3) ta.dataset.userResized = '1';
    });
    row.appendChild(lab);
    row.appendChild(ta);
    desc.appendChild(row);
  }
  // 옷·액세서리·신발 모두 설명은 기본 접힘 + [설명 보기] 토글로 통일합니다.
  const descToggle = document.createElement('button');
  descToggle.type = 'button';
  descToggle.className = 'measToggle';
  const applyDesc = () => {
    const open = !!entry._descOpen;
    desc.style.display = open ? '' : 'none';
    descToggle.textContent = open
      ? '▴ 설명 숨기기'
      : (isWorn ? '▾ 설명 보기 (디자인·소재·디테일)' : '▾ 설명 보기 (디자인·소재·디테일)');
    if (open) for (const ta of desc.querySelectorAll('textarea')) autoSizeDesc(ta);
  };
  descToggle.addEventListener('click', () => { entry._descOpen = !entry._descOpen; applyDesc(); });
  const descHost = isWorn ? colRight : gDesc;
  descHost.appendChild(descToggle);
  descHost.appendChild(desc);
  applyDesc();

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
    (isWorn ? colLeft : gPhoto).appendChild(overlay);
    // 옷 대표사진은 드래그해 다른 옷 카드로 놓으면 그 옷과 합쳐집니다(같은 옷의 다른 각도로).
    if (!isWorn && ref) makeDraggablePhoto(overlay, { kind: 'garment', gi: ref.index });
    redrawOverlay();
  }

  // 같은 옷의 다른 각도(뒤/옆) 뷰. 측정엔 안 쓰고 합성 때 외형 참고용으로만 넘깁니다.
  if (!isWorn && ref) renderGarmentViews(gViews, ref.index);

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
  const rowsGrid = document.createElement('div');
  rowsGrid.className = 'specRowsGrid';
  // 실측은 기본 숨김, [치수 보기] 버튼으로 펼칩니다. 사진 아래에 두되 평소엔 접혀 카드가 짧아집니다.
  if (measures.length) {
    const measToggle = document.createElement('button');
    measToggle.type = 'button';
    measToggle.className = 'measToggle';
    const measWrap = document.createElement('div');
    measWrap.className = 'measWrap';
    measWrap.appendChild(master);
    measWrap.appendChild(rowsGrid);
    const applyMeas = () => {
      const open = !!entry._measOpen;
      measWrap.style.display = open ? '' : 'none';
      measToggle.textContent = open ? `▴ 치수 숨기기 (${measures.length})` : `▾ 치수 보기 (${measures.length})`;
    };
    measToggle.addEventListener('click', () => { entry._measOpen = !entry._measOpen; applyMeas(); });
    const measHost = isWorn ? colLeft : gMeas;
    measHost.appendChild(measToggle);
    measHost.appendChild(measWrap);
    applyMeas();
  }

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
    aiTag.textContent = 'AI';
    aiTag.title = 'AI 추정값 — AI가 사진만 보고 추측한 초기값입니다. 실측을 알면 고쳐주세요.';
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
  // 사용자가 직접 드래그로 늘려둔 칸은 그 높이를 존중합니다(다시 줄이지 않음).
  if (textarea.dataset.userResized) return;
  const max = 4 * 19 + 22; // 기본은 최대 4줄까지 자동으로 늘림
  textarea.style.height = 'auto';
  const needed = textarea.scrollHeight;
  const overflowing = needed > max;
  const h = Math.min(needed, max);
  textarea.style.height = `${h}px`;
  textarea.dataset.autoH = String(h); // 수동 드래그 감지용 기준 높이
  // 4줄을 넘길 때만 스크롤바 + 드래그로 늘리는 핸들을 보입니다. 안 넘으면 둘 다 숨김.
  textarea.style.overflowY = overflowing ? 'auto' : 'hidden';
  textarea.style.resize = overflowing ? 'vertical' : 'none';
}

// 옷 / 액세서리 / 신발을 각각의 영역에 같은 형식(같은 spec box, 같은 사진 크기)으로 그립니다.
function renderSpecs() {
  specGrid.innerHTML = '';
  accGrid.innerHTML = '';
  shoesGrid.innerHTML = '';

  // 업로드된 사진 기준으로 그립니다(분석 결과 기준이 아니라). 아직 분석하지 않은 사진도
  // 자리를 지키고 [분석하기] 버튼을 갖게 되므로, 사진을 새로 올린 뒤 그 항목만 태울 수 있습니다.
  let garmentCount = 0;
  files.garment.forEach((file, i) => {
    garmentCount++;
    const box = document.createElement('div');
    box.className = 'specBox';
    specGrid.appendChild(box);
    makeGarmentDropTarget(box, i); // 사진을 이 카드로 끌어놓으면 합치기/뷰이동
    const entry = specs.garment[i];
    const ref = { key: 'garment', index: i };
    if (entry && entry.spec) renderSpecBox(box, entry, garmentTitleAt(i), 'garment', ref);
    else renderPendingBox(box, file, `옷 ${i + 1} (분석 대기)`, 'garment', ref);
  });
  // 뷰가 하나라도 있으면 "별도 옷으로 분리" 드롭 존을 그리드 끝에 둡니다(뷰 드래그 시 강조).
  if (garmentViews.some((v) => v && v.length)) specGrid.appendChild(makeNewGarmentZone());
  renderLayerBar();

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

  // 레이아웃이 끝난 뒤 실제 가로폭을 재서 옷 사진의 세로 상한을 정합니다.
  requestAnimationFrame(capGarmentPhotoHeights);
}

// 옷 사진의 세로 최대 = 카드 가로폭 × 1.2 (종횡비는 유지). 세로로 긴 옷 사진이 카드를
// 너무 길게 만드는 걸 막습니다. 액세서리/신발 사진은 대상이 아닙니다.
function capGarmentPhotoHeights() {
  for (const cv of specGrid.querySelectorAll('.specOverlay')) {
    const w = (cv.parentElement && cv.parentElement.clientWidth) || cv.clientWidth;
    if (w) cv.style.maxHeight = `${Math.round(w * 1.2)}px`;
  }
}
window.addEventListener('resize', () => requestAnimationFrame(capGarmentPhotoHeights));

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
  { label: '레이어링', match: () => true },
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
          if (b.entries.length) sections.push({ label: b.sub.label, entries: b.entries, layering: b.sub.layering });
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
      // 칩 라벨은 지시사항 생성 모델이 실제 옷 구성에 맞게 붙인 카테고리를 그대로 보여줍니다.
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
    // 체형 선택/되돌리기 기준이 되는 원본 스냅샷을 저장하고, 체형 카드를 노출합니다.
    originalModelFile = files.model[0];
    originalModelSpec = JSON.parse(JSON.stringify(modelSpec));
    reshapedActive = false;
    selectedBodyPresetId = 'original';
    // 기록을 원본으로 초기화(이후 재렌더 결과가 여기 쌓입니다).
    reshapeHistory = [{ name: '분석 원본', dataUrl, spec: JSON.parse(JSON.stringify(modelSpec)), file: originalModelFile, active: true }];
    if (bodyTypeSection) bodyTypeSection.style.display = '';
    resetHairSelection(); // 헤어/색상 유지로 초기화 + 스와치 렌더
    renderModelSpec();
    updateSelectedBodyLabel();
    renderReshapeHistory();
    if (reshapeBtn) reshapeBtn.disabled = true;
    if (reshapeHint) { reshapeHint.textContent = ''; reshapeHint.classList.remove('warn'); }
    timer.stop(true);
    setStatus('모델 체형 분석 완료. 아래 체형 카드를 골라 [모델 재렌더]하거나, 값을 수정한 뒤 [옷 분석]으로 진행하세요.');
  } catch (err) {
    console.error(err); timer.stop(false); setStatus('실패: ' + err.message);
  } finally { refreshButtonStates(); }
});

// ---- 2단계: 옷 실측 분석(겹마다) + 액세서리/신발 이름 분류 ----
// 한 장씩 분석합니다. 사진 한 장만 바꿨을 때 전체를 다시 태우면 다른 아이템에 손으로
// 고쳐 둔 실측·설명이 전부 날아가므로, 항목 단위로 분리해 두고 필요한 것만 돌립니다.
// forcedCategory를 주면(사용자가 종류를 고친 경우) 그 종류로 확정해 다시 분석합니다.
async function analyzeGarmentAt(slotKey, i, analysisModel, forcedCategory) {
  const file = files[slotKey][i];
  const dataUrl = await toUploadDataUrl(file);
  const res = await fetch('/api/v27/analyze-garment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ garment: dataUrl, analysisModel, forcedCategory }),
  });
  const data = await parseJsonOrThrow(res);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const prev = specs[slotKey][i];
  const cat = ['top', 'bottom', 'dress', 'set'].includes(data.spec.category) ? data.spec.category : 'top';
  specs[slotKey][i] = {
    spec: data.spec,
    img: await loadImageFromFile(file),
    // 옷 설명(디자인·소재·디테일)은 렌더링 품질에 도움되므로 기본 ON. 재분석 시엔 이전 값 유지.
    include: prev ? prev.include : true,
    category: forcedCategory || cat,
  };
}

async function analyzeWornAt(key, i, analysisModel) {
  const file = files[key][i];
  const dataUrl = await toUploadDataUrl(file);
  const res = await fetch('/api/v27/classify-item', {
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
// forcedCategory가 있으면(종류 드롭다운 변경) 그 종류로 확정해 재분석합니다.
async function reanalyzeOne(kind, key, i, control, forcedCategory) {
  // control은 [재분석] 버튼일 수도, 종류 드롭다운(select)일 수도 있습니다. select의 textContent를
  // 건드리면 옵션이 지워지므로 버튼일 때만 라벨을 바꿉니다.
  const isBtn = control.tagName === 'BUTTON';
  const label = isBtn ? control.textContent : '';
  control.disabled = true;
  if (isBtn) control.textContent = '분석 중...';
  setStatus('분석 중...');
  try {
    if (kind === 'garment') await analyzeGarmentAt(key, i, selectedAnalysisModel(), forcedCategory);
    else await analyzeWornAt(key, i, selectedAnalysisModel());
    if (kind === 'garment') autoOrderLayers(); // 종류/실측이 바뀌면 겹 순서도 1차 재정렬(손대기 전까지)
    renderSpecs();
    setStatus(forcedCategory ? '종류를 바꿔 다시 분석했습니다.' : '해당 항목만 다시 분석했습니다.');
  } catch (err) {
    console.error(err);
    control.disabled = false;
    if (isBtn) control.textContent = label;
    setStatus(`재분석 실패: ${err.message || err}`);
  }
  refreshButtonStates();
}

analyzeBtn.addEventListener('click', async () => {
  if (!requiredImagesPresent()) {
    setStatus('모델 사진과 옷 사진(1장 이상)이 필요합니다.');
    return;
  }
  analyzeBtn.disabled = true;
  const timer = startTimer(garmentElapsed, '옷 분석');

  const analysisModel = selectedAnalysisModel();

  // 자동 그룹핑: 같은 옷의 다른 각도 사진을 대표+뷰로 먼저 묶습니다(첫 일괄 분석에서만).
  // 그러면 아래 분석 루프는 대표 사진만 실측 분석하고, 뷰는 자동으로 딸려갑니다.
  setStatus('같은 옷 사진 자동 그룹핑 중...');
  const grouped = await autoGroupGarments(analysisModel);
  if (grouped) renderSpecs();

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
  // 같은 종류 옷이 여러 벌이면 안→밖 순서를 1차 자동 정렬합니다(사용자가 손대기 전까지).
  const reordered = autoOrderLayers();
  renderSpecs();

  timer.stop(failed.length === 0);
  if (failed.length) {
    console.error(failed.map((f) => f.reason));
    setStatus(`일부 분석 실패 (${failed.length}건): ${failed[0].reason?.message || ''}`);
  } else {
    const g = grouped ? '같은 옷 사진은 자동으로 묶었어요(틀리면 카드의 [합치기]/뷰의 [분리]로 교정). ' : '';
    const o = reordered ? '겹 순서를 안→밖으로 자동 정렬했어요(카드의 ◀안쪽/겉▶으로 바꿀 수 있음). ' : '';
    setStatus(`분석 완료. ${g}${o}실측을 고치고(잠긴 항목은 비율 연동) [피팅 지시사항 생성]을 누르세요.`);
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
    // 카테고리별로 topSpecs/bottomSpecs/dressSpecs(+ 이미지)로 나눠 보냅니다. set은 dress로.
    const buckets = bucketGarments();
    for (const [slot, idxs] of Object.entries(buckets)) {
      payload[`${slot}Specs`] = idxs.map((i) => specs.garment[i].spec);
      payload[`${slot}Images`] = await Promise.all(idxs.map((i) => toUploadDataUrl(files.garment[i])));
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
    const res = await fetch('/api/v27/fitting-instructions', {
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
      const res = await fetch('/api/v27/synthesize', {
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
  // 뒷면 같이 생성(방법1): 백엔드가 앞·뒤 한 장 프롬프트 + 1:1 정사각으로 호출합니다.
  // 뷰 모드: front(앞면만) / both(앞·뒤 1:1) / four(앞·완전좌·뒤·완전우 16:9). 백엔드가 뷰별 프롬프트+종횡비로 호출.
  const vm = document.querySelector('input[name="viewMode"]:checked');
  payload.viewMode = vm ? vm.value : 'front';

  const buckets = bucketGarments();
  for (const [slot, idxs] of Object.entries(buckets)) {
    payload[`${slot}Images`] = await Promise.all(idxs.map((i) => toUploadDataUrl(files.garment[i])));
  }
  // 추가 뷰(뒤/옆)는 "이미 위에 있는 옷의 다른 각도"로 매니페스트 끝에 붙입니다. 어느 옷인지
  // 이름표를 달아, 이미지 모델이 새 옷으로 오해하지 않고 같은 옷 재현에만 쓰게 합니다.
  const extraViewImages = [];
  const extraViewLabels = [];
  for (let i = 0; i < specs.garment.length; i++) {
    const entry = specs.garment[i];
    const views = garmentViews[i];
    if (!entry || !entry.spec || !views || !views.length) continue;
    for (const v of views) {
      extraViewImages.push(await toUploadDataUrl(v.file));
      extraViewLabels.push(`${garmentTitleAt(i)} — ${entry.spec.garment_type || ''}`.trim());
    }
  }
  payload.extraViewImages = extraViewImages;
  payload.extraViewLabels = extraViewLabels;
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
  specs.garment.forEach((entry, i) => {
    if (!entry || !entry.include || !entry.spec) return;
    const body = describeEntry(garmentTitleAt(i), entry.spec);
    if (body) descriptions.push(body);
  });
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
