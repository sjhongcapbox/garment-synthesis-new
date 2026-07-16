// 피팅샷 v2.2 에디터 — v2.1(new.js)과 캔버스/메쉬 와프 엔진은 동일하지만, AI 드레이프 기준과
// 최종 단계가 다릅니다:
// 1) [참조이미지 만들기]가 실제 업로드한 모델 사진이 아니라 항상 똑바로 서 있는 더미
//    (dummy.jpg)를 [IMAGE 1]로 삼아 AI 드레이프를 요청합니다(prompt-ai-outline-dummy.txt).
//    모델이 삐딱하게 서 있으면 AI가 자세를 전혀 못 맞추는 문제를 원천 차단하기 위함입니다.
// 2) v2.1의 [저장](AI 재합성 없이 캔버스 그대로 저장) 대신, v2 원래 방식처럼 [입히기] 버튼이
//    모델 사진 + 상/하의 원본 + 지금 더미 위 배치(mockup)를 함께 서버로 보내 기존
//    garment-test.ts/prompt-2.txt AI 최종 합성으로 실제 모델에게 입힙니다.

const MAX_DISPLAY_HEIGHT = 860;
const HANDLE_RADIUS = 2.5; // 옷을 선택했을 때 나오는 컨트롤 포인트(점) 반지름(디스플레이 px)
const HANDLE_HIT_RADIUS = 10;
const CORNER_SIZE = 9; // 바운딩 박스 코너/변 리사이즈 핸들 크기(디스플레이 px)
const CORNER_HIT_RADIUS = 11; // 코너/변 핸들 히트 반경(디스플레이 px)
const ROTATE_HANDLE_DIST = 26; // 회전 핸들이 위쪽 변에서 떨어진 거리(디스플레이 px)
const ROTATE_HIT_RADIUS = 11; // 회전 핸들 히트 반경(디스플레이 px)
const SELECTION_PADDING = 14; // 선택 박스/리사이즈 핸들을 실제 점 바운딩 박스보다 이만큼(디스플레이 px) 더 바깥으로 띄움

const state = {
  mode: 'separate', // 'separate'(상의/하의) | 'dress'(원피스) — 별개의 두 모드. 서로의 상태를 공유하지 않습니다.
  modelDataUrl: null,
  topSourceDataUrl: null,
  bottomSourceDataUrl: null,
  dressSourceDataUrl: null,
  modelImg: null,
  displayScale: 1,
  top: null, // GarmentState (separate 모드)
  bottom: null, // GarmentState (separate 모드)
  dress: null, // GarmentState (dress 모드)
  selectedGarment: null, // 'top' | 'bottom' | 'dress' | null — 파워포인트처럼 클릭하면 선택되어 바운딩 박스가 보임
  drag: null, // { garment: 'top'|'bottom'|'dress', mode: 'point'|'group'|'scale-corner'|'scale-edge'|'rotate', ... }
  frontGarment: 'top', // 'top' | 'bottom' — 왼쪽 위 [겹침 순서] 버튼으로 수동으로 바꿉니다. 앞쪽 옷은 반투명 밑칠로 뒤쪽을 가립니다. (separate 모드 전용)
};

const stage = document.getElementById('stage');
const ctx = stage.getContext('2d');
const statusEl = document.getElementById('status');
const runBtn = document.getElementById('runBtn');
const applyBtn = document.getElementById('applyBtn');
const topFrontBtn = document.getElementById('topFrontBtn');
const bottomFrontBtn = document.getElementById('bottomFrontBtn');
const resultWrap = document.getElementById('resultWrap');
const modelThumb = document.getElementById('modelThumb');
const topThumb = document.getElementById('topThumb');
const bottomThumb = document.getElementById('bottomThumb');
const dressThumb = document.getElementById('dressThumb');
const topOutlineThumb = document.getElementById('topOutlineThumb');
const bottomOutlineThumb = document.getElementById('bottomOutlineThumb');
const dressOutlineThumb = document.getElementById('dressOutlineThumb');
const topOutlineTiming = document.getElementById('topOutlineTiming');
const bottomOutlineTiming = document.getElementById('bottomOutlineTiming');
const dressOutlineTiming = document.getElementById('dressOutlineTiming');
const modeSeparateBtn = document.getElementById('modeSeparateBtn');
const modeDressBtn = document.getElementById('modeDressBtn');
const prodHint = document.getElementById('prodHint');

function formatSeconds(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}초` : '';
}
const modalOverlay = document.getElementById('modalOverlay');
const modalImg = document.getElementById('modalImg');

function setStatus(text) { statusEl.textContent = text; }

// 서버(혹은 그 뒤의 GCP 프록시)가 오류 상황에서 JSON이 아니라 HTML 에러 페이지를 돌려주는
// 경우가 있어, res.json()이 바로 터지면 "Unexpected token '<'..." 같은 정체불명 에러만
// 남습니다. 먼저 텍스트로 읽고 파싱해서, 실패 시 실제 응답 내용(앞부분)을 에러 메시지에
// 포함시켜 원인을 바로 알 수 있게 합니다.
async function parseJsonOrThrow(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`서버가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bindThumbPreview(inputId, thumbEl) {
  document.getElementById(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) { thumbEl.classList.remove('show'); return; }
    thumbEl.src = await fileToDataUrl(file);
    thumbEl.classList.add('show');
  });
}
bindThumbPreview('modelFile', modelThumb);
bindThumbPreview('topFile', topThumb);
bindThumbPreview('bottomFile', bottomThumb);
bindThumbPreview('dressFile', dressThumb);

modalOverlay.addEventListener('click', () => modalOverlay.classList.remove('show'));

function openModal(src) {
  if (!src) return;
  modalImg.src = src;
  modalOverlay.classList.add('show');
}

// AI 드레이프 미리보기 썸네일도 결과 이미지와 마찬가지로 클릭하면 팝업으로 확대해서 봅니다.
topOutlineThumb.addEventListener('click', () => openModal(topOutlineThumb.src));
bottomOutlineThumb.addEventListener('click', () => openModal(bottomOutlineThumb.src));
dressOutlineThumb.addEventListener('click', () => openModal(dressOutlineThumb.src));

// ---- 모드 전환 (상의/하의 모드 <-> 원피스 모드) ----
// 별개의 두 모드입니다 — 모드를 바꾸면 지금까지 추출/배치한 옷 상태는 초기화되고 더미만
// 남은 캔버스로 되돌아갑니다(입히기/운영 피팅샷 결과 기록은 그대로 둡니다).
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.className = mode === 'dress' ? 'mode-dress' : 'mode-separate';
  modeSeparateBtn.classList.toggle('active', mode === 'separate');
  modeDressBtn.classList.toggle('active', mode === 'dress');
  prodHint.textContent = mode === 'dress'
    ? '메쉬 편집/더미/레이아웃 목업 없이, 모델·원피스 원본 사진 2장만 그대로 AI에 보내 한 번에 합성하는 단순 경로입니다(prompt-1-dress.txt).'
    : '메쉬 편집/더미/레이아웃 목업 없이, 모델·상의·하의 원본 사진 3장만 그대로 AI에 보내 한 번에 합성하는 단순 경로입니다(prompt-1-separate.txt).';

  state.top = null;
  state.bottom = null;
  state.dress = null;
  state.selectedGarment = null;
  state.frontGarment = 'top';
  updateLayerToggleUI();
  topFrontBtn.disabled = true;
  bottomFrontBtn.disabled = true;
  applyBtn.disabled = true;
  resultWrap.innerHTML = '';
  topOutlineThumb.src = '';
  bottomOutlineThumb.src = '';
  dressOutlineThumb.src = '';
  topOutlineTiming.textContent = '';
  bottomOutlineTiming.textContent = '';
  dressOutlineTiming.textContent = '';
  resetToDummyCanvas();
  setStatus('');
}
modeSeparateBtn.addEventListener('click', () => setMode('separate'));
modeDressBtn.addEventListener('click', () => setMode('dress'));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---- 메쉬 와프 도형 계산 ----

function centroidOf(points) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / points.length, y: sy / points.length };
}

function makeGarmentState(extract, color) {
  const points = extract.points; // natural, outline 이미지 자체 좌표 (source, 고정)
  const basePoints = points.map((p) => ({
    x: extract.initX + p.x * extract.initScale,
    y: extract.initY + p.y * extract.initScale,
  }));
  return {
    img: null, // loadImage로 채움
    dataUrl: extract.dataUrl,
    naturalWidth: extract.naturalWidth,
    naturalHeight: extract.naturalHeight,
    sourcePoints: points,
    sourceCentroid: centroidOf(points),
    basePoints,
    groupOffset: { dx: 0, dy: 0 },
    pointOffsets: points.map(() => ({ dx: 0, dy: 0 })),
    rotation: 0, // 라디안. 자신의 로컬 바운딩 박스 중심 기준으로 회전한 뒤 groupOffset만큼 평행이동됩니다.
    color,
  };
}

function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function rotatePoint(p, pivot, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = p.x - pivot.x, dy = p.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

// 점 와프(pointOffsets)까지만 반영되고 회전/그룹이동은 아직 적용 안 된 "로컬" 좌표.
// 최종 화면 좌표(targetPoint)는 이 로컬 도형을 자신의 중심(pivot) 기준으로 회전한 뒤
// groupOffset만큼 평행이동해서 만듭니다 — 그래서 이동은 회전 각도와 무관하게 항상
// 마우스를 그대로 따라가고, 점 드래그/스케일만 회전 각도를 고려해서 역변환합니다.
function localTargetPoint(g, i) {
  const b = g.basePoints[i];
  const o = g.pointOffsets[i];
  return { x: b.x + o.dx, y: b.y + o.dy };
}

function localTargetPoints(g) {
  return g.sourcePoints.map((_, i) => localTargetPoint(g, i));
}

// 회전 중심 = 로컬(회전 전) 점들의 바운딩 박스 중심.
function rotationPivot(g) {
  const bbox = bboxOfPoints(localTargetPoints(g));
  return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
}

function toWorld(g, localPt, pivot) {
  const rotated = g.rotation ? rotatePoint(localPt, pivot, g.rotation) : localPt;
  return { x: rotated.x + g.groupOffset.dx, y: rotated.y + g.groupOffset.dy };
}

// 화면(월드) 좌표 -> 회전/이동을 역산한 로컬 좌표. 스케일 드래그 중 마우스 위치를
// pointOffsets와 같은 좌표계로 옮길 때 씁니다.
function worldToLocal(worldPt, pivot, rotation, groupOffset) {
  const wx = worldPt.x - groupOffset.dx;
  const wy = worldPt.y - groupOffset.dy;
  if (!rotation) return { x: wx, y: wy };
  const cos = Math.cos(-rotation), sin = Math.sin(-rotation);
  const dx = wx - pivot.x, dy = wy - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

function targetPoint(g, i) {
  return toWorld(g, localTargetPoint(g, i), rotationPivot(g));
}

// centroid도 다른 target point들과 똑같이 pointOffsets(점 와프/코너·변 리사이즈로 생긴 이동량)를
// 반영해야 합니다. 예전엔 g.basePoints(오프셋 반영 전 고정 좌표)로만 계산해서, 코너/변을
// 드래그해 리사이즈할 때 부채꼴 삼각분할의 중심점(centroid)이 원래 자리에 그대로 남아있고
// 바깥 점들만 새 위치로 움직이는 바람에 "리사이즈"가 아니라 중심에서 비뚤게 늘어나는
// "와프"처럼 보이는 버그가 있었습니다.
function targetCentroid(g) {
  return toWorld(g, centroidOf(localTargetPoints(g)), rotationPivot(g));
}

function allTargetPoints(g) {
  return g.sourcePoints.map((_, i) => targetPoint(g, i));
}

// 선택된 옷의 로컬(회전 전) 바운딩 박스를 기준으로 리사이즈 핸들 8개(코너 4 + 변 중점 4) +
// 회전 핸들의 로컬 좌표를 만들고, pivot 기준 회전+이동시킨 화면(월드) 좌표도 함께 반환합니다.
// local은 스케일 계산에, world는 렌더링/히트테스트에 씁니다.
function handlePositions(g) {
  const tight = bboxOfPoints(localTargetPoints(g));
  const pad = SELECTION_PADDING / state.displayScale;
  const bbox = { minX: tight.minX - pad, minY: tight.minY - pad, maxX: tight.maxX + pad, maxY: tight.maxY + pad };
  const midX = (bbox.minX + bbox.maxX) / 2;
  const midY = (bbox.minY + bbox.maxY) / 2;
  const local = {
    nw: { x: bbox.minX, y: bbox.minY },
    ne: { x: bbox.maxX, y: bbox.minY },
    sw: { x: bbox.minX, y: bbox.maxY },
    se: { x: bbox.maxX, y: bbox.maxY },
    n: { x: midX, y: bbox.minY },
    s: { x: midX, y: bbox.maxY },
    w: { x: bbox.minX, y: midY },
    e: { x: bbox.maxX, y: midY },
    rotate: { x: midX, y: bbox.minY - ROTATE_HANDLE_DIST / state.displayScale },
  };
  const pivot = { x: midX, y: midY };
  const world = {};
  for (const key of Object.keys(local)) world[key] = toWorld(g, local[key], pivot);
  return { local, world, pivot, bbox };
}

// 소스 삼각형(src0,src1,src2) -> 대상 삼각형(dst0,dst1,dst2) 매핑 어파인 변환으로
// img를 그려 넣습니다(캔버스 2D의 표준 "텍스처 삼각형" 트릭).
function drawTriangle(targetCtx, img, srcTri, dstTri) {
  const [s0, s1, s2] = srcTri;
  const [d0, d1, d2] = dstTri;
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-8) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;

  // 부채꼴 삼각분할이라 모든 삼각형이 중심점 한 곳에서 만나는데, 인접한 두 삼각형의 클립
  // 경계가 브라우저 안티앨리어싱 때문에 픽셀 단위로 딱 맞아떨어지지 않으면 그 경계선을 따라
  // 미세한 틈/겹침이 생겨 중심에서 뻗어나가는 방사형 선처럼 보입니다. 텍스처 매핑(a~f)은
  // 원래 삼각형 좌표 그대로 계산하고, 화면에 그릴 클립 영역만 자신의 무게중심 기준으로
  // 살짝(약 0.75px) 부풀려서 이웃 삼각형과 아주 조금 겹치게 하면 그 이음매가 가려집니다.
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const inflate = (p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const scale = (len + 0.75) / len;
    return { x: cx + dx * scale, y: cy + dy * scale };
  };
  const c0 = inflate(d0), c1 = inflate(d1), c2 = inflate(d2);

  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.moveTo(c0.x, c0.y);
  targetCtx.lineTo(c1.x, c1.y);
  targetCtx.lineTo(c2.x, c2.y);
  targetCtx.closePath();
  targetCtx.clip();
  targetCtx.setTransform(a, b, c, d, e, f);
  targetCtx.drawImage(img, 0, 0);
  targetCtx.restore();
}

function drawGarmentTexture(targetCtx, g, scale, img) {
  const n = g.sourcePoints.length;
  const srcCentroid = g.sourceCentroid;
  const dstCentroidRaw = targetCentroid(g);
  const dstCentroid = { x: dstCentroidRaw.x * scale, y: dstCentroidRaw.y * scale };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const srcTri = [srcCentroid, g.sourcePoints[i], g.sourcePoints[j]];
    const t0 = targetPoint(g, i), t1 = targetPoint(g, j);
    const dstTri = [dstCentroid, { x: t0.x * scale, y: t0.y * scale }, { x: t1.x * scale, y: t1.y * scale }];
    drawTriangle(targetCtx, img, srcTri, dstTri);
  }
}

// AI 드레이프 텍스처는 실사 이미지라 자기 자신이 이미 거의 완전 불투명입니다(예전 v2의
// 평평한 반투명 outline 채우기와 다름) — 그래서 앞쪽(위) 옷 텍스처를 그냥 그대로 그리면
// 뒤에 있는 더미 몸/다른 옷이 전혀 안 비쳐서 기장·배치를 맞추기 어렵습니다. 편집 화면에서는
// 앞쪽 옷 텍스처 자체를 OCCLUSION_ALPHA(불투명도 85%)로 그려서 더미 몸이 은은하게 비치도록
// 하고, useOcclusion=false로 부르는 내보내기(피팅샷용 mockup) 캔버스에서는 항상 완전
// 불투명하게 그립니다 — AI 최종 합성에는 반투명하게 섞인 색이 아니라 깨끗한 원본 색이 필요하기 때문입니다.
const OCCLUSION_ALPHA = 0.85;

function drawGarmentMesh(targetCtx, g, scale, isFront, useOcclusion) {
  if (!g || !g.img) return;
  if (isFront && useOcclusion) {
    targetCtx.save();
    targetCtx.globalAlpha = OCCLUSION_ALPHA;
    drawGarmentTexture(targetCtx, g, scale, g.img);
    targetCtx.restore();
    return;
  }
  drawGarmentTexture(targetCtx, g, scale, g.img);
}

function drawHandles(targetCtx, g, scale) {
  if (!g) return;
  const pts = allTargetPoints(g);
  targetCtx.strokeStyle = 'rgba(255,255,255,0.6)';
  targetCtx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    targetCtx.beginPath();
    targetCtx.moveTo(a.x * scale, a.y * scale);
    targetCtx.lineTo(b.x * scale, b.y * scale);
    targetCtx.stroke();
  }
  targetCtx.fillStyle = g.color;
  for (const p of pts) {
    targetCtx.beginPath();
    targetCtx.arc(p.x * scale, p.y * scale, HANDLE_RADIUS, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.strokeStyle = '#fff';
    targetCtx.lineWidth = 1.5;
    targetCtx.stroke();
  }
}

// 파워포인트처럼: 선택된 옷의 현재 범위를 감싸는 점선 사각형(회전된 만큼 같이 기울어짐) +
// 코너 4개/변 중점 4개의 리사이즈 핸들 + 위쪽 회전 핸들을 그립니다. 코너를 잡으면 비율 유지
// 확대/축소, 변 중점을 잡으면 가로 또는 세로만, 맨 위 원형 핸들을 잡으면 회전합니다.
function drawSelectionBox(targetCtx, g, scale) {
  if (!g) return;
  const { world } = handlePositions(g);
  const corners = [world.nw, world.ne, world.se, world.sw];

  targetCtx.save();
  targetCtx.strokeStyle = 'rgba(124,92,255,0.9)';
  targetCtx.lineWidth = 1.5;
  targetCtx.setLineDash([5, 4]);
  targetCtx.beginPath();
  targetCtx.moveTo(corners[0].x * scale, corners[0].y * scale);
  for (let i = 1; i < corners.length; i++) targetCtx.lineTo(corners[i].x * scale, corners[i].y * scale);
  targetCtx.closePath();
  targetCtx.stroke();

  targetCtx.beginPath();
  targetCtx.moveTo(world.n.x * scale, world.n.y * scale);
  targetCtx.lineTo(world.rotate.x * scale, world.rotate.y * scale);
  targetCtx.stroke();
  targetCtx.setLineDash([]);

  targetCtx.fillStyle = '#ffffff';
  targetCtx.strokeStyle = '#7c5cff';
  for (const key of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
    const p = world[key];
    targetCtx.fillRect(p.x * scale - CORNER_SIZE / 2, p.y * scale - CORNER_SIZE / 2, CORNER_SIZE, CORNER_SIZE);
    targetCtx.strokeRect(p.x * scale - CORNER_SIZE / 2, p.y * scale - CORNER_SIZE / 2, CORNER_SIZE, CORNER_SIZE);
  }
  targetCtx.beginPath();
  targetCtx.arc(world.rotate.x * scale, world.rotate.y * scale, CORNER_SIZE / 2, 0, Math.PI * 2);
  targetCtx.fill();
  targetCtx.stroke();
  targetCtx.restore();
}

// 뒤->앞 순서. 배열의 마지막이 화면에서 가장 앞(위)에 보이고, 겹치는 부분에서 뒤쪽을 가립니다.
// 원피스 모드는 옷이 한 벌뿐이라 겹침 순서 자체가 없습니다.
function garmentDrawOrder() {
  if (state.mode === 'dress') return ['dress'];
  return state.frontGarment === 'top' ? ['bottom', 'top'] : ['top', 'bottom'];
}

function render() {
  if (!state.modelImg) return;
  const scale = state.displayScale;
  ctx.clearRect(0, 0, stage.width, stage.height);
  ctx.drawImage(state.modelImg, 0, 0, stage.width, stage.height);
  const order = garmentDrawOrder();
  const frontKey = order[order.length - 1];
  for (const key of order) drawGarmentMesh(ctx, state[key], scale, key === frontKey, true);
  // 컨트롤 포인트(점)는 선택된 옷에서만 보여줍니다 — 안 그러면 상/하의 점이 항상 잔뜩 겹쳐
  // 보여서 어떤 옷을 조정 중인지 헷갈립니다. 옷 안쪽을 클릭해 선택하면 그때 점이 나타납니다.
  if (state.selectedGarment) drawHandles(ctx, state[state.selectedGarment], scale);
  if (state.selectedGarment) drawSelectionBox(ctx, state[state.selectedGarment], scale);
}

function renderExportCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = state.modelImg.naturalWidth;
  canvas.height = state.modelImg.naturalHeight;
  const exportCtx = canvas.getContext('2d');
  exportCtx.drawImage(state.modelImg, 0, 0);
  const order = garmentDrawOrder();
  const frontKey = order[order.length - 1];
  // 내보내기(피팅샷 mockup)는 편집 화면과 달리 항상 완전 불투명하게 그립니다.
  for (const key of order) drawGarmentMesh(exportCtx, state[key], 1, key === frontKey, false);
  return canvas;
}

// ---- 히트 테스트 / 드래그 ----

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTest(displayX, displayY) {
  // 화면(디스플레이) 좌표 -> natural 좌표
  const nx = displayX / state.displayScale;
  const ny = displayY / state.displayScale;

  // 선택된 옷이 있으면, 그 옷의 회전/리사이즈 핸들을 최우선으로 검사합니다
  // (파워포인트처럼 선택 상태에서만 핸들이 나타나고 잡을 수 있음).
  if (state.selectedGarment && state[state.selectedGarment]) {
    const g = state[state.selectedGarment];
    const { world } = handlePositions(g);
    const rotateR = ROTATE_HIT_RADIUS / state.displayScale;
    if (Math.hypot(world.rotate.x - nx, world.rotate.y - ny) < rotateR) {
      return { garment: state.selectedGarment, mode: 'rotate' };
    }
    const hitR = CORNER_HIT_RADIUS / state.displayScale;
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      if (Math.hypot(world[corner].x - nx, world[corner].y - ny) < hitR) {
        return { garment: state.selectedGarment, mode: 'scale-corner', corner };
      }
    }
    for (const edge of ['n', 's', 'w', 'e']) {
      if (Math.hypot(world[edge].x - nx, world[edge].y - ny) < hitR) {
        return { garment: state.selectedGarment, mode: 'scale-edge', edge };
      }
    }
  }

  // 점은 선택된 옷에서만 보이므로, 점 히트테스트도 선택된 옷에서만 합니다 — 안 그러면
  // 화면에 보이지도 않는 다른(미선택) 옷의 점을 실수로 잡게 됩니다.
  if (state.selectedGarment && state[state.selectedGarment]) {
    const pts = allTargetPoints(state[state.selectedGarment]);
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - nx, dy = pts[i].y - ny;
      if (Math.hypot(dx, dy) < HANDLE_HIT_RADIUS / state.displayScale) {
        return { garment: state.selectedGarment, mode: 'point', pointIndex: i };
      }
    }
  }

  const frontToBack = [...garmentDrawOrder()].reverse(); // 화면에 보이는 대로, 앞(위)에 있는 옷부터 검사
  for (const key of frontToBack) {
    const g = state[key];
    if (!g) continue;
    if (pointInPolygon(nx, ny, allTargetPoints(g))) {
      return { garment: key, mode: 'group' };
    }
  }
  return null;
}

// 4방향 화살표 커스텀 커서 (사용자가 지정한 아이콘 모양: 상하좌우로 뻗은 화살표).
// OS/브라우저 기본 'move' 커서는 모양이 제각각이라, SVG를 직접 그려서 고정된 모양을 씁니다.
const MOVE_CURSOR = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24"><g fill="none" stroke="%231e2340" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/></g><g fill="%231e2340"><polygon points="12,0.5 7.5,7 16.5,7"/><polygon points="12,23.5 7.5,17 16.5,17"/><polygon points="0.5,12 7,7.5 7,16.5"/><polygon points="23.5,12 17,7.5 17,16.5"/></g></svg>') 12 12, move`;

function cursorForHit(hit) {
  if (!hit) return 'default';
  if (hit.mode === 'rotate') return 'grab';
  if (hit.mode === 'scale-corner') {
    return (hit.corner === 'nw' || hit.corner === 'se') ? 'nwse-resize' : 'nesw-resize';
  }
  if (hit.mode === 'scale-edge') {
    return (hit.edge === 'n' || hit.edge === 's') ? 'ns-resize' : 'ew-resize';
  }
  return hit.mode === 'group' ? MOVE_CURSOR : 'pointer';
}

stage.addEventListener('mousedown', (e) => {
  const rect = stage.getBoundingClientRect();
  const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) {
    state.selectedGarment = null; // 빈 곳 클릭 -> 선택 해제
    render();
    return;
  }
  state.selectedGarment = hit.garment; // 어떤 방식으로든 상호작용한 옷을 선택 상태로

  const g = state[hit.garment];
  if (hit.mode === 'scale-corner' || hit.mode === 'scale-edge') {
    const { local, pivot, bbox } = handlePositions(g);
    const key = hit.mode === 'scale-corner' ? hit.corner : hit.edge;
    state.drag = {
      garment: hit.garment,
      mode: hit.mode,
      key,
      pivot,
      rotation: g.rotation || 0,
      groupOffsetAtStart: { ...g.groupOffset },
      origLocalBBox: bbox,
      origLocalHandle: local[key],
      origLocalPoints: localTargetPoints(g),
    };
  } else if (hit.mode === 'rotate') {
    const { pivot } = handlePositions(g);
    const worldPivot = { x: pivot.x + g.groupOffset.dx, y: pivot.y + g.groupOffset.dy };
    const mouseNatural = {
      x: (e.clientX - rect.left) / state.displayScale,
      y: (e.clientY - rect.top) / state.displayScale,
    };
    state.drag = {
      garment: hit.garment,
      mode: 'rotate',
      worldPivot,
      startAngle: Math.atan2(mouseNatural.y - worldPivot.y, mouseNatural.x - worldPivot.x),
      rotationAtStart: g.rotation || 0,
    };
  } else {
    const origOffset = hit.mode === 'point' ? { ...g.pointOffsets[hit.pointIndex] } : { ...g.groupOffset };
    state.drag = { ...hit, startClientX: e.clientX, startClientY: e.clientY, origOffset };
  }
  stage.style.cursor = cursorForHit(hit);
  render();
});

stage.addEventListener('mousemove', (e) => {
  if (state.drag) return; // 드래그 중엔 window의 mousemove가 커서를 관리
  const rect = stage.getBoundingClientRect();
  const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  stage.style.cursor = cursorForHit(hit);
});

window.addEventListener('mousemove', (e) => {
  if (!state.drag) return;
  const d = state.drag;
  stage.style.cursor = cursorForHit(d);
  const g = state[d.garment];
  const rect = stage.getBoundingClientRect();

  if (d.mode === 'rotate') {
    const mouseNatural = {
      x: (e.clientX - rect.left) / state.displayScale,
      y: (e.clientY - rect.top) / state.displayScale,
    };
    const angle = Math.atan2(mouseNatural.y - d.worldPivot.y, mouseNatural.x - d.worldPivot.x);
    g.rotation = d.rotationAtStart + (angle - d.startAngle);
    render();
    return;
  }

  if (d.mode === 'scale-corner' || d.mode === 'scale-edge') {
    // 마우스를 도형의 로컬(회전 전) 좌표계로 역변환한 뒤, 고정된 반대쪽 기준점(anchor)
    // 대비 거리 변화 비율만큼 로컬 점들을 확대/축소합니다. 코너는 가로세로 비율 유지,
    // 변 중점은 그 축 방향으로만 늘어나거나 줄어듭니다.
    const mouseWorld = {
      x: (e.clientX - rect.left) / state.displayScale,
      y: (e.clientY - rect.top) / state.displayScale,
    };
    const mouseLocal = worldToLocal(mouseWorld, d.pivot, d.rotation, d.groupOffsetAtStart);
    const bbox = d.origLocalBBox;
    let scaleX = 1, scaleY = 1, anchor;

    if (d.mode === 'scale-corner') {
      const anchorKey = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }[d.key];
      anchor = {
        nw: { x: bbox.minX, y: bbox.minY }, ne: { x: bbox.maxX, y: bbox.minY },
        sw: { x: bbox.minX, y: bbox.maxY }, se: { x: bbox.maxX, y: bbox.maxY },
      }[anchorKey];
      const origDist = Math.hypot(d.origLocalHandle.x - anchor.x, d.origLocalHandle.y - anchor.y);
      const newDist = Math.hypot(mouseLocal.x - anchor.x, mouseLocal.y - anchor.y);
      const factor = origDist > 1e-6 ? Math.max(0.05, newDist / origDist) : 1;
      scaleX = factor; scaleY = factor;
    } else if (d.key === 'e' || d.key === 'w') {
      anchor = { x: d.key === 'e' ? bbox.minX : bbox.maxX, y: bbox.minY };
      const denom = d.origLocalHandle.x - anchor.x;
      scaleX = Math.abs(denom) > 1e-6 ? Math.max(0.05, (mouseLocal.x - anchor.x) / denom) : 1;
    } else {
      anchor = { x: bbox.minX, y: d.key === 's' ? bbox.minY : bbox.maxY };
      const denom = d.origLocalHandle.y - anchor.y;
      scaleY = Math.abs(denom) > 1e-6 ? Math.max(0.05, (mouseLocal.y - anchor.y) / denom) : 1;
    }

    for (let i = 0; i < g.sourcePoints.length; i++) {
      const orig = d.origLocalPoints[i];
      const newX = anchor.x + (orig.x - anchor.x) * scaleX;
      const newY = anchor.y + (orig.y - anchor.y) * scaleY;
      g.pointOffsets[i] = { dx: newX - g.basePoints[i].x, dy: newY - g.basePoints[i].y };
    }
    render();
    return;
  }

  const dxDisplay = e.clientX - d.startClientX;
  const dyDisplay = e.clientY - d.startClientY;
  const dxNatural = dxDisplay / state.displayScale;
  const dyNatural = dyDisplay / state.displayScale;

  if (d.mode === 'point') {
    // pointOffsets는 회전이 적용되기 전 로컬 좌표계에 있으므로, 화면에서 본 마우스
    // 이동량을 -rotation만큼 역회전시켜 로컬 이동량으로 바꿔서 더합니다.
    const angle = g.rotation || 0;
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    const localDx = dxNatural * cos - dyNatural * sin;
    const localDy = dxNatural * sin + dyNatural * cos;
    g.pointOffsets[d.pointIndex] = { dx: d.origOffset.dx + localDx, dy: d.origOffset.dy + localDy };
  } else {
    // groupOffset은 회전 이후 마지막에 더해지는 순수 평행이동이라, 회전 각도와 무관하게
    // 화면에서 움직인 만큼 그대로 더하면 됩니다(마우스를 그대로 따라감).
    g.groupOffset = { dx: d.origOffset.dx + dxNatural, dy: d.origOffset.dy + dyNatural };
  }
  render();
});

window.addEventListener('mouseup', () => {
  state.drag = null;
  stage.style.cursor = 'default';
});

// ---- 버튼 동작 ----

// 겹침 순서(상의가 위 / 하의가 위)를 위아래로 쌓인 두 버튼 토글로 고릅니다.
function updateLayerToggleUI() {
  topFrontBtn.classList.toggle('active', state.frontGarment === 'top');
  bottomFrontBtn.classList.toggle('active', state.frontGarment === 'bottom');
}
function setFrontGarment(key) {
  state.frontGarment = key;
  updateLayerToggleUI();
  render();
}
topFrontBtn.addEventListener('click', () => setFrontGarment('top'));
bottomFrontBtn.addEventListener('click', () => setFrontGarment('bottom'));

async function runSeparateExtract() {
  const modelFile = document.getElementById('modelFile').files[0];
  const topFile = document.getElementById('topFile').files[0];
  const bottomFile = document.getElementById('bottomFile').files[0];
  if (!modelFile || !topFile || !bottomFile) {
    setStatus('모델/상의/하의 이미지를 모두 선택하세요.');
    return;
  }
  runBtn.disabled = true;
  setStatus('AI가 더미(항상 똑바로 선 체형)에 맞춰 옷을 입히는 중... (상/하의 병렬, 1~2분 정도 걸릴 수 있어요)');
  resultWrap.innerHTML = '';
  state.selectedGarment = null;
  state.frontGarment = 'top';
  updateLayerToggleUI();

  try {
    const [modelDataUrl, topDataUrl, bottomDataUrl] = await Promise.all([
      fileToDataUrl(modelFile), fileToDataUrl(topFile), fileToDataUrl(bottomFile),
    ]);
    // 업로드한 실제 모델 사진은 여기서는 안 쓰고(AI 드레이프는 항상 더미 기준), [입히기]
    // 단계에서 최종 합성의 얼굴/포즈 소스로만 쓰기 위해 그대로 들고 있습니다.
    state.modelDataUrl = modelDataUrl;
    state.topSourceDataUrl = topDataUrl;
    state.bottomSourceDataUrl = bottomDataUrl;

    const res = await fetch('/api/extract-v22', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ top: topDataUrl, bottom: bottomDataUrl }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // 캔버스는 더미 위에 그립니다 — 더미는 항상 똑바로 서 있어서 AI 드레이프 결과와
    // 항상 정확히 들어맞습니다.
    const modelImg = await loadImage(data.dummyDataUrl);
    state.modelImg = modelImg;
    state.displayScale = Math.min(1, MAX_DISPLAY_HEIGHT / modelImg.naturalHeight);
    stage.width = Math.round(modelImg.naturalWidth * state.displayScale);
    stage.height = Math.round(modelImg.naturalHeight * state.displayScale);

    state.top = makeGarmentState(data.top, '#f472b6');
    state.bottom = makeGarmentState(data.bottom, '#60a5fa');
    state.top.img = await loadImage(data.top.dataUrl);
    state.bottom.img = await loadImage(data.bottom.dataUrl);

    topOutlineThumb.src = data.top.dataUrl;
    bottomOutlineThumb.src = data.bottom.dataUrl;
    topOutlineTiming.textContent = formatSeconds(data.top.extractMs);
    bottomOutlineTiming.textContent = formatSeconds(data.bottom.extractMs);

    render();
    topFrontBtn.disabled = false;
    bottomFrontBtn.disabled = false;
    applyBtn.disabled = false;
    setStatus('더미 위 배치/기장을 점 드래그 등으로 조정한 뒤 [입히기]를 누르세요.');
  } catch (err) {
    console.error(err);
    setStatus('실패: ' + err.message);
  } finally {
    runBtn.disabled = false;
  }
}

// 원피스 모드: runSeparateExtract와 같은 흐름이지만 옷이 한 장(원피스)뿐입니다.
async function runDressExtract() {
  const modelFile = document.getElementById('modelFile').files[0];
  const dressFile = document.getElementById('dressFile').files[0];
  if (!modelFile || !dressFile) {
    setStatus('모델/원피스 이미지를 모두 선택하세요.');
    return;
  }
  runBtn.disabled = true;
  setStatus('AI가 더미(항상 똑바로 선 체형)에 맞춰 원피스를 입히는 중... (1~2분 정도 걸릴 수 있어요)');
  resultWrap.innerHTML = '';
  state.selectedGarment = null;

  try {
    const [modelDataUrl, dressDataUrl] = await Promise.all([
      fileToDataUrl(modelFile), fileToDataUrl(dressFile),
    ]);
    state.modelDataUrl = modelDataUrl;
    state.dressSourceDataUrl = dressDataUrl;

    const res = await fetch('/api/extract-v22-dress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dress: dressDataUrl }),
    });
    const data = await parseJsonOrThrow(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const modelImg = await loadImage(data.dummyDataUrl);
    state.modelImg = modelImg;
    state.displayScale = Math.min(1, MAX_DISPLAY_HEIGHT / modelImg.naturalHeight);
    stage.width = Math.round(modelImg.naturalWidth * state.displayScale);
    stage.height = Math.round(modelImg.naturalHeight * state.displayScale);

    state.dress = makeGarmentState(data.dress, '#f472b6');
    state.dress.img = await loadImage(data.dress.dataUrl);

    dressOutlineThumb.src = data.dress.dataUrl;
    dressOutlineTiming.textContent = formatSeconds(data.dress.extractMs);

    render();
    applyBtn.disabled = false;
    setStatus('더미 위 배치/기장을 점 드래그 등으로 조정한 뒤 [입히기]를 누르세요.');
  } catch (err) {
    console.error(err);
    setStatus('실패: ' + err.message);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', () => {
  if (state.mode === 'dress') runDressExtract();
  else runSeparateExtract();
});

// 완료된 결과 하나를 그리드에 새로 추가합니다(placeholder 없이 바로 이미지로).
function appendResultItem(container, src, labelText) {
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
  container.appendChild(item);
  return item;
}

// 버튼을 누르는 즉시 스피너가 도는 placeholder를 그리드 맨 뒤(다음 빈 칸)에 만들어 둡니다.
// 실제 결과는 이 placeholder 자리에서 그대로 이미지로 바뀝니다 — 그래야 여러 번 연달아
// 눌러도 몇 번째로 요청한 결과인지 자리(순서)가 흐트러지지 않습니다.
function appendPendingResultItem(container) {
  const item = document.createElement('div');
  item.className = 'resultItem pending';
  const box = document.createElement('div');
  box.className = 'pendingBox';
  box.innerHTML = '<div class="spinner"></div>';
  const label = document.createElement('span');
  label.className = 'resultLabel';
  label.textContent = '생성 중...';
  item.appendChild(box);
  item.appendChild(label);
  container.appendChild(item);
  return { item, box, label };
}

// [입히기]는 버튼을 막지 않습니다 — 클릭할 때마다 즉시 placeholder를 하나 만들고, 실제 AI
// 합성 요청은 백그라운드에서 독립적으로 진행됩니다. 그래서 한 요청이 아직 도는 중에도
// 배치를 더 조정해서 또 [입히기]를 누를 수 있고, 여러 결과가 동시에 진행됩니다.
applyBtn.addEventListener('click', () => {
  if (!state.modelImg) return;
  const isDress = state.mode === 'dress';
  const modelDataUrl = state.modelDataUrl;
  const topSourceDataUrl = state.topSourceDataUrl;
  const bottomSourceDataUrl = state.bottomSourceDataUrl;
  const dressSourceDataUrl = state.dressSourceDataUrl;
  const mockupDataUrl = renderExportCanvas().toDataURL('image/png');
  const { item, box, label } = appendPendingResultItem(resultWrap);
  setStatus(isDress
    ? '모델 사진 + 원피스 + 더미 배치를 함께 보내 AI 최종 합성 중... (1~2분 정도 걸릴 수 있어요)'
    : '모델 사진 + 상/하의 + 더미 배치를 함께 보내 AI 최종 합성 중... (1~2분 정도 걸릴 수 있어요)');

  (async () => {
    try {
      const res = await fetch(isDress ? '/api/synthesize-dress' : '/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isDress ? {
          model: modelDataUrl,
          dress: dressSourceDataUrl,
          mockup: mockupDataUrl,
        } : {
          model: modelDataUrl,
          top: topSourceDataUrl,
          bottom: bottomSourceDataUrl,
          mockup: mockupDataUrl,
        }),
      });
      const data = await parseJsonOrThrow(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // placeholder를 그 자리에서 첫 번째 결과 이미지로 바꿔치기합니다.
      box.remove();
      const img = document.createElement('img');
      img.src = data.resultDataUrls[0];
      img.addEventListener('click', () => openModal(img.src));
      item.classList.remove('pending');
      item.insertBefore(img, label);
      label.textContent = data.resultDataUrls.length > 1 ? '결과 1' : '결과';
      // 한 요청에서 결과가 여러 장 나오면(드묾) 나머지는 그리드 맨 뒤에 새로 추가합니다.
      for (let i = 1; i < data.resultDataUrls.length; i++) {
        appendResultItem(resultWrap, data.resultDataUrls[i], `결과 ${i + 1}`);
      }
      setStatus('완료: ' + data.savedPaths.join(', '));
    } catch (err) {
      console.error(err);
      box.remove();
      item.classList.remove('pending');
      item.classList.add('failed');
      label.textContent = '실패';
      label.title = err.message;
      setStatus('실패: ' + err.message);
    }
  })();
});

// "운영 피팅샷" — 메쉬 편집/더미/레이아웃 목업을 전혀 거치지 않고, 모델·상의·하의 파일 입력에서
// 바로 읽어 prompt-1.txt로 한 번에 합성합니다. [참조이미지 만들기]를 먼저 실행할 필요가 없는
// 독립적인 경로라, state가 아니라 파일 입력에서 직접 dataURL을 읽습니다. [입히기]와 동일하게
// 버튼을 막지 않고 여러 번 연달아 누를 수 있습니다.
const prodBtn = document.getElementById('prodBtn');
const prodResultWrap = document.getElementById('prodResultWrap');

prodBtn.addEventListener('click', async () => {
  const isDress = state.mode === 'dress';
  const modelFile = document.getElementById('modelFile').files[0];
  const topFile = document.getElementById('topFile').files[0];
  const bottomFile = document.getElementById('bottomFile').files[0];
  const dressFile = document.getElementById('dressFile').files[0];
  if (isDress ? (!modelFile || !dressFile) : (!modelFile || !topFile || !bottomFile)) {
    setStatus(isDress ? '모델/원피스 이미지를 모두 선택하세요.' : '모델/상의/하의 이미지를 모두 선택하세요.');
    return;
  }
  const [modelDataUrl, topDataUrl, bottomDataUrl, dressDataUrl] = await Promise.all([
    fileToDataUrl(modelFile),
    isDress ? Promise.resolve(null) : fileToDataUrl(topFile),
    isDress ? Promise.resolve(null) : fileToDataUrl(bottomFile),
    isDress ? fileToDataUrl(dressFile) : Promise.resolve(null),
  ]);
  const { item, box, label } = appendPendingResultItem(prodResultWrap);
  setStatus(isDress
    ? '운영 피팅샷: 모델 + 원피스 원본만으로 AI 합성 중... (1~2분 정도 걸릴 수 있어요)'
    : '운영 피팅샷: 모델 + 상/하의 원본만으로 AI 합성 중... (1~2분 정도 걸릴 수 있어요)');

  (async () => {
    try {
      const res = await fetch(isDress ? '/api/synthesize-prod-dress' : '/api/synthesize-prod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isDress
          ? { model: modelDataUrl, dress: dressDataUrl }
          : { model: modelDataUrl, top: topDataUrl, bottom: bottomDataUrl }),
      });
      const data = await parseJsonOrThrow(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      box.remove();
      const img = document.createElement('img');
      img.src = data.resultDataUrls[0];
      img.addEventListener('click', () => openModal(img.src));
      item.classList.remove('pending');
      item.insertBefore(img, label);
      label.textContent = data.resultDataUrls.length > 1 ? '결과 1' : '결과';
      for (let i = 1; i < data.resultDataUrls.length; i++) {
        appendResultItem(prodResultWrap, data.resultDataUrls[i], `결과 ${i + 1}`);
      }
      setStatus('운영 피팅샷 완료: ' + data.savedPaths.join(', '));
    } catch (err) {
      console.error(err);
      box.remove();
      item.classList.remove('pending');
      item.classList.add('failed');
      label.textContent = '실패';
      label.title = err.message;
      setStatus('실패: ' + err.message);
    }
  })();
});

// ---- 더미(마네킹)만 있는 초기 화면으로 되돌립니다. 더미는 절대 안 바뀌므로 옷을 업로드/추출
// 하기 전에도(첫 로드), 그리고 모드를 전환할 때도 바로 캔버스에 띄울 수 있습니다.
// [참조이미지 만들기] 이후엔 서버가 돌려주는 dummyDataUrl로 다시 한번 갱신됩니다(캔버스 크기/
// 스케일 재계산을 그 흐름과 동일하게 유지하기 위함일 뿐, 이미지 자체는 동일).
async function resetToDummyCanvas() {
  try {
    const img = await loadImage('/dummy.jpg');
    state.modelImg = img;
    state.displayScale = Math.min(1, MAX_DISPLAY_HEIGHT / img.naturalHeight);
    stage.width = Math.round(img.naturalWidth * state.displayScale);
    stage.height = Math.round(img.naturalHeight * state.displayScale);
    render();
  } catch (err) {
    console.error('더미 이미지 로드 실패:', err);
  }
}
resetToDummyCanvas();
