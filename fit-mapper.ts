// v2.4 전용: "옷 cm ↔ 모델 몸" 계산을 LLM이 아니라 코드가 결정론적으로 수행합니다.
//
// v2.3의 문제: 옷 실측(cm)과 모델 실측(cm)을 그대로 LLM(Function B)에 던지고 "네가 착지점을
// 계산해라"라고 시켰습니다. LLM은 산수가 흔들려서 "밑단이 어디에 떨어지는가"가 들쭉날쭉했고,
// 표현도 "적당히 종아리 밑"처럼 모호했습니다.
//
// v2.4의 방식: 모델 실측으로 이 모델만의 "세로 지도(신체 랜드마크 사다리)"를 만들고, 옷의
// 총장/소매길이/단면 수치를 단순 뺄셈·나눗셈으로 그 지도 위 한 점에 매핑한 뒤, 그 높이를
// 표준 랜드마크 어휘("무릎 아래 종아리 상단 1/3 지점" 등)로 변환합니다. 둘레는 여유량(ease)을
// 계산해 핏 등급으로 분류합니다. 이 모든 계산은 코드가 하므로 항상 정확하고 재현 가능합니다.
// LLM(Function B)은 이 "이미 계산된 FIT MAP"을 자연스러운 한국어 문장으로 옮기기만 합니다.
//
// 좌표계: 모든 높이는 "바닥에서 위로 cm". 바닥=0, 머리끝=키(height_cm).

export interface FitModel {
  height_cm: number;
  weight_kg?: number;
  shoulder_width_cm: number;
  chest_cm: number;
  waist_cm: number;
  hip_cm: number;
  arm_length_cm: number;   // 어깨 끝 ~ 손목
  torso_length_cm: number; // 어깨선 ~ 자연 허리
  leg_length_cm: number;   // 자연 허리 ~ 바닥
}

export interface FitGarmentMeasurement {
  label: string;
  value_cm: number;
}

export interface FitGarmentSpec {
  garment_type?: string;
  description?: string;
  measurements: FitGarmentMeasurement[];
}

// 한 옷의 계산 결과(구조화). 프론트에서 "착지점 표"로 그대로 보여주고, 텍스트로도 묶어
// 프롬프트에 넣습니다.
export interface FitRow {
  label: string;
  value_cm: number;
  kind: 'hem' | 'sleeve' | 'ease' | 'shoulder' | 'note' | 'silhouette';
  result: string;     // 사람이 읽는 한 줄 결론 (예: "밑단 착지: 무릎 아래 종아리 상단 …")
  // 밑단(hem) 행일 때 계산된 착지 높이(바닥에서 cm). 레이어링 판정이 결과 문자열을 다시
  // 파싱하지 않도록 숫자를 그대로 들고 있습니다(문자열 파싱은 문구가 바뀌면 깨집니다).
  hemH?: number;
}

export interface FitGarmentResult {
  slot: 'top' | 'bottom' | 'dress' | 'accessory' | 'shoes';
  type: string;
  rows: FitRow[];
  // v2.5 레이어링: 같은 슬롯에 여러 벌이 겹쳐 입혀질 때 몇 번째 겹인지 표시.
  // (예: "상의 L1 (이너)", "상의 L2 (겉)") 한 벌뿐이면 비워 둡니다.
  layerLabel?: string;
}

export interface FitMap {
  ladder: Array<{ name: string; h: number }>;
  garments: FitGarmentResult[];
  text: string; // 프롬프트(Function B)로 넣을 사전 계산 FIT MAP 텍스트
}

// ── 신체 세로 사다리(바닥에서 위로, cm) ────────────────────────────────────
// 측정된 앵커(허리높이=다리길이, 어깨높이=다리길이+상체길이)를 authoritative로 쓰고,
// 측정이 없는 지점(무릎/발목/골반/사타구니)은 인체 비례 상수로 보간합니다.
// 하체 상수는 "다리길이(허리~바닥) L"의 분수로 정의합니다. 인체계측에서 허리높이≈0.605·키,
// 즉 키 H≈1.653·L 관계를 써서 아래 분수를 유도했습니다(예: 발목높이 0.039·H = 0.065·L).
interface BodyLadder {
  floor: number;      // 0
  ankle: number;      // 발목
  knee: number;       // 무릎(슬개골 중앙)
  crotch: number;     // 사타구니
  hip: number;        // 엉덩이 가장 넓은 지점
  waist: number;      // 자연 허리
  bust: number;       // 가슴(버스트)
  underbust: number;  // 명치(언더버스트)
  shoulder: number;   // 어깨선
  head: number;       // 머리끝
}

function buildLadder(m: FitModel): BodyLadder {
  const L = m.leg_length_cm;      // 허리~바닥
  const T = m.torso_length_cm;    // 어깨~허리
  const waist = L;
  const shoulder = L + T;
  return {
    floor: 0,
    ankle: 0.065 * L,
    knee: 0.47 * L,
    crotch: 0.79 * L,
    hip: 0.88 * L,
    waist,
    underbust: waist + 0.45 * T,
    bust: waist + 0.62 * T,
    shoulder,
    head: m.height_cm,
  };
}

// 바닥에서 h(cm) 높이가 몸의 어디에 해당하는지 한국어 랜드마크 문구로 변환.
function describeBodyHeight(h: number, lad: BodyLadder): string {
  const { ankle, knee, crotch, hip, waist, underbust, bust, shoulder } = lad;
  if (h >= shoulder - 1) return '어깨선 근처(넥라인/어깨 위)';
  if (h >= bust) return '가슴(버스트) 부근';
  if (h >= underbust) return '명치(언더버스트) 부근, 하이 크롭';
  if (h >= waist + 0.15 * (shoulder - waist)) return '허리 위·갈비뼈 아래(크롭)';
  if (h >= waist * 0.99) return '허리선 지점';
  if (h >= hip) {
    const f = (h - hip) / (waist - hip); // 0=골반, 1=허리
    if (f > 0.66) return '허리 바로 아래·골반 상단';
    if (f > 0.33) return '골반 중간(엉덩이뼈 높이)';
    return '골반 아래쪽·엉덩이 상단';
  }
  if (h >= crotch) {
    const f = (h - crotch) / (hip - crotch); // 0=사타구니, 1=골반
    if (f > 0.5) return '엉덩이 중간을 덮는 길이';
    return '엉덩이 아랫선·사타구니 부근';
  }
  if (h >= knee) {
    const f = (h - knee) / (crotch - knee); // 0=무릎, 1=사타구니
    if (f > 0.8) return '허벅지 최상단(사타구니 바로 아래, 매우 짧음)';
    if (f > 0.55) return '허벅지 상단';
    if (f > 0.3) return '허벅지 중간';
    if (f > 0.12) return '허벅지 하단(무릎 위)';
    return '무릎 바로 위';
  }
  if (h >= ankle) {
    const f = (h - ankle) / (knee - ankle); // 0=발목, 1=무릎
    if (f > 0.85) return '무릎 바로 아래';
    if (f > 0.62) return '무릎 아래·종아리 상단 약 1/3 지점';
    if (f > 0.4) return '종아리 중간';
    if (f > 0.2) return '종아리 하단';
    return '발목 바로 위(종아리 끝자락)';
  }
  if (h >= ankle * 0.5) return '발목 지점';
  if (h > 0) return '발등을 덮는 길이';
  return '바닥에 닿거나 끌리는 길이';
}

// 착지 높이를 "가장 가까운 신체 랜드마크로부터의 거리"로도 표현합니다.
// "바닥에서 73cm"는 그림으로 못 그리지만 "사타구니에서 아래로 9cm"는 그릴 수 있습니다.
function nearestLandmarkNote(h: number, lad: BodyLadder): string {
  const pts: Array<[string, number]> = [
    ['어깨', lad.shoulder], ['가슴', lad.bust], ['허리', lad.waist], ['골반', lad.hip],
    ['사타구니', lad.crotch], ['무릎', lad.knee], ['발목', lad.ankle], ['바닥', lad.floor],
  ];
  let best = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(h - p[1]);
    if (d < bestD) { bestD = d; best = p; }
  }
  const diff = h - best[1];
  if (Math.abs(diff) < 1.5) return `${best[0]} 높이와 거의 같음`;
  return `${best[0]}에서 ${diff > 0 ? '위로' : '아래로'} 약 ${Math.abs(Math.round(diff))}cm`;
}

// 둘레 여유(ease)를 "옷이 몸 표면에서 실제로 얼마나 떠 있는지"(반경 간격)로 환산합니다.
// 둘레 여유 E는 원 둘레 차이이므로 반경 간격 ≈ E / 2π. 이게 화가가 그릴 수 있는 숫자입니다.
function easeGapNote(easeCm: number): string {
  if (easeCm <= 0) return '몸에 밀착되어 눌림(옷과 몸 사이 공간 없음)';
  const gap = Math.round((easeCm / (2 * Math.PI)) * 2) / 2;
  if (gap < 0.5) return '몸에 거의 닿을 듯 가까움';
  return `옷이 몸 표면에서 사방으로 약 ${gap}cm 떠서 흐름`;
}

// 소매 길이 -> 팔 어디에서 끝나는지.
function describeSleeve(sleeveLen: number, armLen: number): string {
  if (!armLen || armLen <= 0) return `소매길이 ${sleeveLen}cm`;
  const f = sleeveLen / armLen;
  if (f <= 0.02) return '민소매(어깨선에서 끝)';
  if (f < 0.12) return '어깨 바로 아래(캡 소매)';
  if (f < 0.22) return '상완(이두) 상단 — 짧은 반소매';
  if (f < 0.32) return '상완(이두) 중간 — 반소매';
  if (f < 0.42) return '팔꿈치 위';
  if (f < 0.52) return '팔꿈치 지점';
  if (f < 0.66) return '전완(팔뚝) 상단';
  if (f < 0.8) return '전완 중간';
  if (f < 0.92) return '손목 위';
  if (f <= 1.03) return '손목 지점(긴소매)';
  const over = sleeveLen - armLen;
  return `손목을 지나 손등을 덮음(약 ${over.toFixed(0)}cm 오버)`;
}

// 둘레 여유량(ease, cm) -> 핏 등급. 단면(반폭)은 호출 전에 ×2 해서 넘깁니다.
function easeGrade(easeCm: number): string {
  if (easeCm <= -3) return '밀착(신축 소재 전제)';
  if (easeCm <= 2) return '타이트/슬림';
  if (easeCm <= 7) return '정핏(레귤러)';
  if (easeCm <= 14) return '세미 루즈';
  if (easeCm <= 22) return '루즈';
  return '오버사이즈/와이드';
}

// ── 라벨 매칭 헬퍼 ─────────────────────────────────────────────────────────
function stripPiece(label: string): string {
  return label.replace(/^\s*(상의|하의)\s*/, '').trim();
}
// 라벨 표기가 "가슴 단면"/"스트랩 드롭"처럼 띄어쓰기를 달리해도 찾을 수 있게 공백을 지우고 비교합니다.
function findMeasure(list: FitGarmentMeasurement[], keyword: string): number | null {
  const key = keyword.replace(/\s+/g, '');
  const hit = list.find((m) => stripPiece(m.label).replace(/\s+/g, '').includes(key));
  return hit && Number.isFinite(hit.value_cm) ? hit.value_cm : null;
}
function round1(n: number): number { return Math.round(n * 10) / 10; }

// 하나의 옷(상의/하의/원피스)에 대한 착지점/여유/실루엣을 계산.
function analyzeGarment(
  slot: 'top' | 'bottom' | 'dress',
  spec: FitGarmentSpec,
  m: FitModel,
  lad: BodyLadder,
): FitGarmentResult {
  const rows: FitRow[] = [];
  const ms = spec.measurements || [];
  // 총장은 상의/원피스는 어깨에서, 하의는 (자연 허리 착용 가정) 허리에서 잽니다.
  const total = findMeasure(ms, '총장');
  if (total != null) {
    if (slot === 'bottom') {
      const hemH = lad.waist - total; // 자연 허리 착용 가정
      rows.push({
        label: '총장', value_cm: total, kind: 'hem', hemH,
        result: `밑단 착지: ${describeBodyHeight(hemH, lad)} — ${nearestLandmarkNote(hemH, lad)} (바닥에서 약 ${Math.max(0, Math.round(hemH))}cm, 자연 허리 착용 가정)`,
      });
    } else {
      const hemH = lad.shoulder - total; // 상의/원피스: 어깨에서 아래로
      rows.push({
        label: '총장', value_cm: total, kind: 'hem', hemH,
        result: `밑단 착지: ${describeBodyHeight(hemH, lad)} — ${nearestLandmarkNote(hemH, lad)} (바닥에서 약 ${Math.max(0, Math.round(hemH))}cm)`,
      });
    }
  }
  // 소매
  const sleeve = findMeasure(ms, '소매길이');
  if (sleeve != null) {
    rows.push({
      label: '소매길이', value_cm: sleeve, kind: 'sleeve',
      result: `소매 끝: ${describeSleeve(sleeve, m.arm_length_cm)}`,
    });
  }
  // 어깨너비(단면 아님 — 어깨 끝점 사이 직선끼리 비교)
  const shoulderW = findMeasure(ms, '어깨너비');
  if (shoulderW != null && m.shoulder_width_cm) {
    const d = round1(shoulderW - m.shoulder_width_cm);
    // 어깨너비 차이는 좌우 양쪽의 합이므로, 그릴 때 쓸 값은 한쪽당 절반입니다.
    const perSide = Math.abs(round1(d / 2));
    const verdict = d <= -2 ? `어깨선이 어깨 끝보다 한쪽당 약 ${perSide}cm 안쪽에 앉음(슬림)`
      : d < 2 ? '어깨선이 어깨 끝에 거의 딱 맞음(정핏)'
      : `어깨 봉제선이 어깨 끝점보다 한쪽당 약 ${perSide}cm 바깥, 팔 윗면에 얹힘(드롭숄더/오버핏)`;
    rows.push({
      label: '어깨너비', value_cm: shoulderW, kind: 'shoulder',
      result: `옷 어깨 ${shoulderW} vs 몸 어깨 ${m.shoulder_width_cm} = ${d >= 0 ? '+' : ''}${d}cm → ${verdict}`,
    });
  }
  // 둘레 여유(단면 ×2 vs 몸 둘레)
  const easePairs: Array<{ kw: string; body: number; name: string }> = [
    { kw: '가슴단면', body: m.chest_cm, name: '가슴' },
    { kw: '허리단면', body: m.waist_cm, name: '허리' },
    { kw: '엉덩이단면', body: m.hip_cm, name: '엉덩이' },
    { kw: '힙단면', body: m.hip_cm, name: '힙' },
  ];
  for (const p of easePairs) {
    const flat = findMeasure(ms, p.kw);
    if (flat == null || !p.body) continue;
    const circ = flat * 2;
    const ease = round1(circ - p.body);
    const bandNote = p.kw === '허리단면' && (findMeasure(ms, '밴딩') != null || /밴딩|고무|스모크|드로/.test(spec.description || ''))
      ? ' (밴딩/신축이면 실제 착용은 몸에 맞게 조여짐)' : '';
    rows.push({
      label: p.kw, value_cm: flat, kind: 'ease',
      result: `${p.name} 둘레 ${circ} vs 몸 ${p.body} = ${ease >= 0 ? '+' : ''}${ease}cm → ${easeGrade(ease)} · ${easeGapNote(ease)}${bandNote}`,
    });
  }
  // 밑위(rise) — 참고용 노트
  const rise = findMeasure(ms, '밑위');
  if (rise != null) {
    const note = rise >= 30 ? '하이웨스트 경향' : rise >= 25 ? '정상 허리' : '로우라이즈 경향';
    rows.push({ label: '밑위', value_cm: rise, kind: 'note', result: `밑위 ${rise}cm → ${note} (참고)` });
  }
  // 실루엣: 폭 사다리로 판정
  const silhouette = classifySilhouette(slot, ms);
  if (silhouette) rows.push({ label: '실루엣', value_cm: 0, kind: 'silhouette', result: silhouette });
  return { slot, type: spec.garment_type || '(무명)', rows };
}

// 폭 사다리로 실루엣 분류(수치를 함께 적어 근거를 남깁니다).
function classifySilhouette(slot: 'top' | 'bottom' | 'dress', ms: FitGarmentMeasurement[]): string | null {
  if (slot === 'bottom') {
    const hip = findMeasure(ms, '엉덩이단면');
    const thigh = findMeasure(ms, '허벅지단면');
    const knee = findMeasure(ms, '무릎단면');
    const hem = findMeasure(ms, '밑단부리');
    const parts = [hip && `엉덩이${hip}`, thigh && `허벅지${thigh}`, knee && `무릎${knee}`, hem && `밑단${hem}`].filter(Boolean).join('→');
    if (thigh != null && hem != null) {
      let cls: string;
      if (hem >= thigh * 1.05) cls = '밑단으로 넓어지는 A라인/플레어/와이드';
      else if (hem <= thigh * 0.8) cls = '허벅지에서 부풀었다 밑단으로 좁아지는 테이퍼드/배럴';
      else cls = '위아래 폭이 비슷한 스트레이트';
      return `폭 사다리(${parts}) → ${cls}`;
    }
    return parts ? `폭 사다리(${parts})` : null;
  }
  // 상의/원피스
  const chest = findMeasure(ms, '가슴단면');
  const waist = findMeasure(ms, '허리단면');
  const hem = findMeasure(ms, '밑단단면');
  const parts = [chest && `가슴${chest}`, waist && `허리${waist}`, hem && `밑단${hem}`].filter(Boolean).join('→');
  if (chest != null && hem != null) {
    let cls: string;
    if (hem >= chest * 1.08) cls = '밑단으로 퍼지는 A라인/플레어';
    else if (hem <= chest * 0.92) cls = '밑단이 오므라드는 배럴/블루종';
    else cls = '직선으로 떨어지는 스트레이트/박시';
    return `폭 사다리(${parts}) → ${cls}`;
  }
  return parts ? `폭 사다리(${parts})` : null;
}

// 원피스 슬롯인데 실제로는 상하의 세트(라벨이 상의/하의로 접두)면 두 벌로 쪼갭니다.
function splitSetIfNeeded(dress: FitGarmentSpec): FitGarmentSpec[] | null {
  const ms = dress.measurements || [];
  const hasTop = ms.some((x) => /^\s*상의/.test(x.label));
  const hasBottom = ms.some((x) => /^\s*하의/.test(x.label));
  if (!(hasTop && hasBottom)) return null;
  const top: FitGarmentSpec = { garment_type: (dress.garment_type || '') + ' (상의)', description: dress.description, measurements: ms.filter((x) => /^\s*상의/.test(x.label)).map((x) => ({ label: stripPiece(x.label), value_cm: x.value_cm })) };
  const bottom: FitGarmentSpec = { garment_type: (dress.garment_type || '') + ' (하의)', description: dress.description, measurements: ms.filter((x) => /^\s*하의/.test(x.label)).map((x) => ({ label: stripPiece(x.label), value_cm: x.value_cm })) };
  return [top, bottom];
}

// 레이어링(상의가 하의 위/안)에 대한 코드 판정: 상의 밑단 높이 vs 하의 허리(착용) 높이.
function layeringNote(topRes: FitGarmentResult | undefined, lad: BodyLadder): string | null {
  if (!topRes) return null;
  const hemRow = topRes.rows.find((r) => r.kind === 'hem');
  if (!hemRow || hemRow.hemH == null) return null;
  const topHemH = Math.round(hemRow.hemH);
  const rel = topHemH - lad.waist; // +면 상의 밑단이 허리보다 위, -면 아래
  if (rel > 4) return `상의 밑단(바닥 ${topHemH}cm)이 하의 허리선(${Math.round(lad.waist)}cm)보다 위에서 끝남 → 넣어 입지 않으면 하의 윗단이 그대로 드러남(짧은 상의)`;
  if (rel > -6) return `상의 밑단(${topHemH}cm)이 하의 허리선(${Math.round(lad.waist)}cm) 근처 → 걸치면 하의 윗단을 살짝 덮거나 딱 맞닿음`;
  return `상의 밑단(${topHemH}cm)이 하의 허리선(${Math.round(lad.waist)}cm)보다 아래 → 밖으로 걸쳐 입으면 하의 윗단이 상의에 가려 보이지 않음`;
}

// 전체 FIT MAP을 만듭니다. garments 중 null은 건너뜁니다.
export function buildFitMap(
  model: FitModel,
  garments: { top?: FitGarmentSpec | null; bottom?: FitGarmentSpec | null; dress?: FitGarmentSpec | null },
): FitMap {
  const lad = buildLadder(model);
  const results: FitGarmentResult[] = [];

  if (garments.dress) {
    const set = splitSetIfNeeded(garments.dress);
    if (set) {
      results.push(analyzeGarment('top', set[0], model, lad));
      results.push(analyzeGarment('bottom', set[1], model, lad));
    } else {
      results.push(analyzeGarment('dress', garments.dress, model, lad));
    }
  } else {
    if (garments.top) results.push(analyzeGarment('top', garments.top, model, lad));
    if (garments.bottom) results.push(analyzeGarment('bottom', garments.bottom, model, lad));
  }

  const topRes = results.find((r) => r.slot === 'top');
  const layer = results.some((r) => r.slot === 'top') && results.some((r) => r.slot === 'bottom')
    ? layeringNote(topRes, lad) : null;

  // ── 프롬프트로 넣을 텍스트 ──
  const ladderStr = [
    `어깨 ${Math.round(lad.shoulder)}`, `가슴 ${Math.round(lad.bust)}`, `허리 ${Math.round(lad.waist)}`,
    `골반 ${Math.round(lad.hip)}`, `사타구니 ${Math.round(lad.crotch)}`, `무릎 ${Math.round(lad.knee)}`,
    `발목 ${Math.round(lad.ankle)}`, `바닥 0`,
  ].join(' / ');

  const slotLabel: Record<string, string> = { top: 'TOP 상의', bottom: 'BOTTOM 하의', dress: 'DRESS 원피스' };
  const blocks: string[] = [];
  for (const g of results) {
    const lines = g.rows.map((r) => `- ${r.label}${r.value_cm ? ` ${r.value_cm}` : ''}: ${r.result}`);
    blocks.push(`[${slotLabel[g.slot]}] ${g.type}\n${lines.join('\n')}`);
  }
  if (layer) blocks.push(`[LAYERING 레이어링]\n- ${layer}`);

  const text = [
    '=== PRE-COMPUTED FIT MAP (정확한 기하로 계산 완료 — 재계산 금지) ===',
    '아래 착지점/여유/실루엣은 모델 몸과 옷 스펙에서 정확한 뺄셈·나눗셈으로 이미 계산된 확정 사실입니다.',
    '다시 계산하지 말고, 다른 위치로 바꾸지 말고, 이 값을 자연스러운 한국어 피팅 문장으로 옮기기만 하세요.',
    '',
    `모델 세로 사다리(바닥에서 위로, cm): ${ladderStr}`,
    '',
    blocks.join('\n\n'),
  ].join('\n');

  const ladder = [
    { name: '어깨', h: round1(lad.shoulder) }, { name: '가슴', h: round1(lad.bust) },
    { name: '허리', h: round1(lad.waist) }, { name: '골반', h: round1(lad.hip) },
    { name: '사타구니', h: round1(lad.crotch) }, { name: '무릎', h: round1(lad.knee) },
    { name: '발목', h: round1(lad.ankle) }, { name: '바닥', h: 0 },
  ];
  return { ladder, garments: results, text };
}

// ===== v2.5: 한 슬롯에 여러 벌이 겹쳐 입혀지는 레이어링 =====
// 상의 최대 3겹(셔츠→가디건→코트), 하의 최대 2겹처럼 배열로 받습니다.
// 배열 순서 = 착장 순서(index 0이 가장 안쪽, 마지막이 가장 바깥).

export interface LayeredGarments {
  tops?: FitGarmentSpec[];
  bottoms?: FitGarmentSpec[];
  dresses?: FitGarmentSpec[];
  accessories?: FitAccessorySpec[];
  shoes?: FitAccessorySpec[];
}

// 액세서리/신발: 옷과 달리 "핏"이 아니라 **스케일과 걸리는 위치**가 문제입니다.
// (제품 사진만으로는 미니백인지 대형 토트인지 알 수 없어 이미지 모델이 크기를 자주 틀림)
export interface FitAccessorySpec {
  kind: 'accessory' | 'shoes';
  name: string;
  worn_on?: string;
  // 착용 방법(어깨에 메기 / 크로스로 메기 / 팔에 걸기 / 손에 들기 / 등에 메기 …).
  // 같은 가방도 이 값에 따라 매달리는 높이가 완전히 달라지므로 계산의 입력입니다.
  wear_style?: string;
  measurements: FitGarmentMeasurement[];
}

// 가방이 매달리는 높이처럼 "몸의 어느 높이에 오는가"를 옷 기장과 다른 중립적 표현으로 서술.
// (describeBodyHeight는 "크롭" 등 옷 전용 표현이 섞여 있어 액세서리에는 맞지 않습니다.)
function describeHangHeight(h: number, lad: BodyLadder): string {
  const { ankle, knee, crotch, hip, waist, underbust, bust, shoulder } = lad;
  if (h >= shoulder - 2) return '어깨 높이';
  if (h >= bust) return '가슴 높이';
  if (h >= underbust) return '명치(언더버스트) 높이';
  if (h >= waist) return '허리 바로 위·갈비뼈 아래 높이';
  if (h >= hip) return '허리와 골반 사이 높이';
  if (h >= crotch) return '골반~엉덩이 높이';
  if (h >= knee) return '허벅지 높이';
  if (h >= ankle) return '무릎 아래~종아리 높이';
  return '발목 아래 높이';
}

// 아이템 크기를 모델 어깨너비 대비 비율로 환산 — 화가가 몸을 기준으로 크기를 가늠할 수 있게.
function sizeVsShoulder(valueCm: number, shoulderW: number): string {
  if (!shoulderW) return `${valueCm}cm`;
  const r = valueCm / shoulderW;
  const grade = r < 0.35 ? '아주 작은(미니) 크기'
    : r < 0.6 ? '작은 크기'
    : r < 0.9 ? '중간 크기'
    : r < 1.2 ? '큰 크기'
    : '아주 큰 대형';
  return `모델 어깨너비(${shoulderW}cm)의 약 ${r.toFixed(2)}배 → ${grade}`;
}

function analyzeWornItem(spec: FitAccessorySpec, m: FitModel, lad: BodyLadder): FitGarmentResult {
  const rows: FitRow[] = [];
  const ms = spec.measurements || [];

  // 가방이 매달리는 높이는 "착용 방법"에 종속됩니다. 어깨/크로스로 메면 스트랩 드롭이
  // 높이를 결정하지만, 팔에 걸면 팔꿈치, 손에 들면 손목 높이에 걸리고 드롭은 무의미해집니다.
  const drop = findMeasure(ms, '스트랩드롭');
  const style = (spec.wear_style || '').replace(/\s+/g, '');
  const elbowH = lad.shoulder - 0.45 * (m.arm_length_cm || 0);
  const wristH = lad.shoulder - (m.arm_length_cm || 0);
  if (style.includes('손에')) {
    rows.push({
      label: '착용 방법', value_cm: 0, kind: 'note',
      result: `손에 들기 — 팔을 내린 상태의 손 높이에서 가방이 들려, 본체 상단이 ${describeHangHeight(wristH, lad)}(${nearestLandmarkNote(wristH, lad)})에 옵니다. 스트랩 드롭은 이 착용법에서는 높이에 영향이 없습니다.`,
    });
  } else if (style.includes('팔') || style.includes('팔꿈치')) {
    rows.push({
      label: '착용 방법', value_cm: 0, kind: 'note',
      result: `팔(팔꿈치)에 걸기 — 팔꿈치 안쪽에 손잡이를 걸어 본체가 ${describeHangHeight(elbowH, lad)}(${nearestLandmarkNote(elbowH, lad)}) 부근에 놓입니다.`,
    });
  } else if (style.includes('등에') || style.includes('백팩')) {
    rows.push({
      label: '착용 방법', value_cm: 0, kind: 'note',
      result: '등에 메기(백팩) — 양쪽 어깨끈을 메고 본체가 등에 밀착되며, 앞에서 보면 어깨끈만 보이고 본체는 몸에 가려 거의 보이지 않습니다.',
    });
  } else if (drop != null) {
    const hangH = lad.shoulder - drop;
    const cross = style.includes('크로스');
    // 사용자가 직접 써넣은 착용 방법이면 그 문구를 그대로 쓰고, 없을 때만 기본 표현을 씁니다
    // (커스텀 문구를 "어깨에 메기"로 덮어쓰면 사용자의 지시가 사라집니다).
    const custom = spec.wear_style && !style.includes('자연스럽게') ? spec.wear_style : '';
    const label = custom || (cross ? '크로스로 메기' : '어깨에 메기');
    rows.push({
      label: '스트랩드롭', value_cm: drop, kind: 'note',
      result: `${label} — 스트랩이 어깨에 걸리는 지점에서 ${drop}cm 내려와 가방 본체 상단이 ${describeHangHeight(hangH, lad)}에 옴 — ${nearestLandmarkNote(hangH, lad)}${cross ? '. 스트랩이 어깨에서 반대쪽 허리로 몸통을 가로지릅니다.' : ''}`,
    });
  } else if (style && !style.includes('자연스럽게')) {
    rows.push({ label: '착용 방법', value_cm: 0, kind: 'note', result: spec.wear_style as string });
  }
  // 부츠: 목 높이를 다리 사다리에 매핑 (앵클/미들/니하이 구분이 여기서 결정됨)
  const shaft = findMeasure(ms, '목높이');
  if (shaft != null) {
    const topH = lad.ankle + shaft;
    rows.push({
      label: '목높이', value_cm: shaft, kind: 'hem', hemH: topH,
      result: `부츠 목 상단이 ${describeBodyHeight(topH, lad)} — ${nearestLandmarkNote(topH, lad)}`,
    });
  }
  const heel = findMeasure(ms, '굽높이');
  if (heel != null) {
    const note = heel < 2 ? '플랫에 가까움' : heel < 5 ? '낮은 굽' : heel < 8 ? '중간 굽' : '높은 굽';
    rows.push({
      label: '굽높이', value_cm: heel, kind: 'note',
      result: `굽 ${heel}cm → ${note}. 발뒤꿈치가 그만큼 들려 다리가 길어 보이고 종아리에 긴장이 생기는 자세`,
    });
  }
  for (const kw of ['가로', '챙너비']) {
    const v = findMeasure(ms, kw);
    if (v != null) rows.push({ label: kw, value_cm: v, kind: 'note', result: `${kw} ${v}cm — ${sizeVsShoulder(v, m.shoulder_width_cm)}` });
  }
  const vert = findMeasure(ms, '세로');
  if (vert != null && m.torso_length_cm) {
    rows.push({
      label: '세로', value_cm: vert, kind: 'note',
      result: `세로 ${vert}cm — 모델 상체길이(${m.torso_length_cm}cm)의 약 ${(vert / m.torso_length_cm).toFixed(2)}배 높이`,
    });
  }
  const len = findMeasure(ms, '길이');
  if (len != null && m.height_cm) {
    rows.push({
      label: '길이', value_cm: len, kind: 'note',
      result: `길이 ${len}cm — 모델 키(${m.height_cm}cm)의 약 ${(len / m.height_cm).toFixed(2)}배`,
    });
  }
  if (!rows.length) {
    rows.push({
      label: '크기', value_cm: 0, kind: 'note',
      result: '크기가 그림에 영향을 주지 않는 아이템 — 사진의 외형 그대로 자연스러운 크기로 착용',
    });
  }
  const wornNote = spec.worn_on ? ` · 착용 부위: ${spec.worn_on}` : '';
  const styleNote = spec.wear_style ? ` · 착용 방법: ${spec.wear_style}` : '';
  rows.unshift({ label: '착용', value_cm: 0, kind: 'note', result: `${spec.name}${wornNote}${styleNote}` });
  return { slot: spec.kind === 'shoes' ? 'shoes' : 'accessory', type: spec.name, rows };
}

function ladderOf(lad: BodyLadder): Array<{ name: string; h: number }> {
  return [
    { name: '어깨', h: round1(lad.shoulder) }, { name: '가슴', h: round1(lad.bust) },
    { name: '허리', h: round1(lad.waist) }, { name: '골반', h: round1(lad.hip) },
    { name: '사타구니', h: round1(lad.crotch) }, { name: '무릎', h: round1(lad.knee) },
    { name: '발목', h: round1(lad.ankle) }, { name: '바닥', h: 0 },
  ];
}

// 같은 슬롯 안에서 몇 번째 겹인지 라벨을 붙입니다(한 벌뿐이면 라벨 없음).
function layerLabelFor(base: string, index: number, total: number): string | undefined {
  if (total <= 1) return undefined;
  const role = index === 0 ? '이너' : index === total - 1 ? '겉' : '중간';
  return `${base} L${index + 1} (${role})`;
}

const hemHeightOf = (r: FitGarmentResult): number | undefined =>
  r.rows.find((x) => x.kind === 'hem')?.hemH;
const sleeveLenOf = (r: FitGarmentResult): number | undefined =>
  r.rows.find((x) => x.kind === 'sleeve')?.value_cm;

// 가려짐(오클루전) 판정. 겹쳐 입으면 안쪽 옷의 소매·밑단은 겉옷에 가려 화면에 안 보이는데,
// 그 부분의 착지점을 그대로 지시로 내보내면 이미지 모델이 "안쪽 옷도 보여줘야 한다"고 읽고
// 겉옷 소매를 없애 조끼로 만들어버리는 사고가 납니다(실제 발생). 그래서 가려지는 항목은
// 착지점 대신 "가려져 보이지 않음 + 렌더링하지 말 것"으로 바꿔 넣습니다.
// 반환: { notes, hemHandled } — hemHandled는 밑단 가려짐을 이미 말한 안쪽 겹의 이름 집합.
// 같은 사실을 layerRelationNotes가 또 쓰면 지시사항에 "이너는 안 보인다"가 대여섯 줄씩
// 반복돼 정작 중요한 문장이 묻힙니다(실제 발생). 그래서 겹 하나당 한 줄로 합칩니다.
// 한 겹 스택(list는 inner→outer 순서)에 대해 소매·밑단 가려짐을 판정합니다.
// applyOcclusion(v2.5: 슬롯별 호출)과 buildFitMapAuto(v2.6: 상의+원피스 통합 스택)가 공유합니다.
function occludeOrderedList(list: FitGarmentResult[], notes: string[], hemHandled: Set<string>): void {
  if (list.length < 2) return;
  for (let i = 0; i < list.length - 1; i++) {
    const inner = list[i];
    const outers = list.slice(i + 1);
    const innerName = inner.layerLabel || inner.type;
    // 이 겹에 대해 "무엇이 가려지는지"를 조각으로 모았다가 마지막에 한 문장으로 냅니다.
    const hidden: string[] = [];

    // 소매: 겉옷 소매가 같거나 더 길면 안쪽 소매는 통째로 가려집니다.
    const innerSleeve = sleeveLenOf(inner);
    const outerSleeves = outers.map(sleeveLenOf).filter((v): v is number => v != null);
    if (innerSleeve != null && outerSleeves.length) {
      const maxOuter = Math.max(...outerSleeves);
      const row = inner.rows.find((x) => x.kind === 'sleeve');
      if (maxOuter >= innerSleeve - 1) {
        if (row) row.result = `겉옷 소매(${maxOuter}cm)가 더 길어 이 소매는 팔 전체가 겉옷 안에 들어가 화면에 전혀 보이지 않음 → 이 옷의 소매·커프스는 그리지 말 것(겉옷 소매를 짧게 하거나 없애서 드러내려 하지 말 것).`;
        hidden.push('소매 전체');
      } else {
        const out = Math.round(innerSleeve - maxOuter);
        if (row) row.result += ` (겉옷 소매보다 약 ${out}cm 길어, 소맷단 ${out}cm만 겉옷 소매 밖으로 나와 보임)`;
        notes.push(`${innerName}: 소맷단이 겉옷 소매 밖으로 약 ${out}cm 나와 그 부분만 보입니다.`);
      }
    }

    // 밑단: 겉옷 밑단이 더 아래면 안쪽 밑단은 가려집니다.
    const innerHem = hemHeightOf(inner);
    const outerHems = outers.map(hemHeightOf).filter((v): v is number => v != null);
    if (innerHem != null && outerHems.length) {
      const lowest = Math.min(...outerHems); // 높이가 작을수록 더 아래
      const row = inner.rows.find((x) => x.kind === 'hem');
      if (lowest <= innerHem + 1 && row) {
        row.result = '겉옷 밑단이 더 아래에 있어 이 밑단은 완전히 가려져 화면에 보이지 않음 → 이 옷의 밑단선은 그리지 말 것.';
        hidden.push('밑단');
        hemHandled.add(innerName);
      }
    }

    // 가려지는 부분 + 보이는 부분을 한 줄로. 여러 줄로 나누면 문장화 단계에서 같은 말이
    // 각각 한 항목씩 만들어져 레이어링 항목만 대여섯 개가 됩니다.
    const hiddenPart = hidden.length ? `${hidden.join('·')}이(가) 겉옷에 완전히 가려지고, ` : '';
    notes.push(
      `${innerName}: ${hiddenPart}실제로 보이는 부분은 겉옷이 열린 앞여밈 중앙과 목·칼라 주변뿐입니다`
      + '(어깨·옆선·등은 가려짐). 겉옷은 자기 사진 그대로의 구조를 유지합니다.',
    );
  }
}

function applyOcclusion(results: FitGarmentResult[]): { notes: string[]; hemHandled: Set<string> } {
  const notes: string[] = [];
  const hemHandled = new Set<string>();
  for (const slot of ['top', 'dress'] as const) {
    occludeOrderedList(results.filter((r) => r.slot === slot), notes, hemHandled);
  }
  return { notes, hemHandled };
}

// 한 겹 스택(inner→outer)에서 밑단의 높낮이 관계를 서술합니다(가려짐/삐져나옴/나란함).
function hemRelationsOrderedList(list: FitGarmentResult[], notes: string[], hemHandled: Set<string>): void {
  const name = (r: FitGarmentResult) => r.layerLabel || r.type;
  for (let i = 0; i + 1 < list.length; i++) {
    const inner = list[i];
    const outer = list[i + 1];
    const hi = hemHeightOf(inner);
    const ho = hemHeightOf(outer);
    if (hi == null || ho == null) continue;
    const d = Math.round(hi - ho); // 양수면 겉옷 밑단이 더 아래(겉옷이 더 김)
    if (d > 3) {
      if (hemHandled.has(name(inner))) continue; // [VISIBILITY]에서 이미 말한 사실
      notes.push(`${name(outer)}이(가) ${name(inner)}보다 밑단이 약 ${d}cm 더 아래 → 안쪽 옷의 밑단이 겉옷에 완전히 가려 보이지 않음`);
    } else if (d < -3) {
      notes.push(`${name(inner)}이(가) ${name(outer)}보다 밑단이 약 ${Math.abs(d)}cm 더 아래 → 겉옷 밑단 아래로 안쪽 옷 밑단이 그만큼 삐져나와 보임`);
    } else {
      notes.push(`${name(inner)}과 ${name(outer)}의 밑단 높이가 거의 같음(차이 약 ${Math.abs(d)}cm) → 두 밑단이 나란히 겹쳐 보임`);
    }
  }
}

// 가장 안쪽 상의 ↔ 하의 허리선 관계(넣어 입기/빼서 걸치기). 상의·하의가 모두 있을 때만.
function topBottomWaistNote(tops: FitGarmentResult[], bottoms: FitGarmentResult[], lad: BodyLadder, notes: string[]): void {
  const name = (r: FitGarmentResult) => r.layerLabel || r.type;
  if (tops.length && bottoms.length) {
    const innerTop = tops[0];
    const h = hemHeightOf(innerTop);
    if (h != null) {
      const topHemH = Math.round(h);
      const waistH = Math.round(lad.waist);
      const rel = topHemH - waistH;
      if (rel > 4) {
        notes.push(`가장 안쪽 상의(${name(innerTop)}) 밑단(${topHemH}cm)이 하의 허리선(${waistH}cm)보다 위 → 넣어 입지 않으면 하의 윗단이 그대로 드러남`);
      } else if (rel > -6) {
        notes.push(`가장 안쪽 상의(${name(innerTop)}) 밑단(${topHemH}cm)이 하의 허리선(${waistH}cm) 근처 → 걸치면 하의 윗단을 살짝 덮거나 딱 맞닿음`);
      } else {
        notes.push(`가장 안쪽 상의(${name(innerTop)}) 밑단(${topHemH}cm)이 하의 허리선(${waistH}cm)보다 아래 → 밖으로 걸쳐 입으면 하의 윗단이 가려 보이지 않음`);
      }
    }
    if (tops.length > 1) {
      notes.push('겉에 겹쳐 입는 아우터는 하의 안으로 넣지 않고 항상 밖으로 걸쳐 입습니다.');
    }
  }
}

// 레이어 간 관계를 코드가 판정합니다: 겉옷이 안쪽 옷을 덮는지, 안쪽 옷이 삐져나오는지.
// (이미지 모델이 "무엇이 보이고 무엇이 가려지는지"를 그릴 수 있게 하는 것이 목적)
// hemHandled에 든 겹은 이미 [VISIBILITY]에서 밑단 가려짐을 말했으므로 여기서 또 쓰지 않습니다.
function layerRelationNotes(results: FitGarmentResult[], lad: BodyLadder, hemHandled: Set<string>): string[] {
  const notes: string[] = [];

  for (const slot of ['top', 'bottom', 'dress'] as const) {
    hemRelationsOrderedList(results.filter((r) => r.slot === slot), notes, hemHandled);
  }

  // 가장 안쪽 상의 ↔ 하의 허리선 관계(넣어 입기/빼서 걸치기). 겉옷은 항상 밖으로 걸칩니다.
  const tops = results.filter((r) => r.slot === 'top');
  const bottoms = results.filter((r) => r.slot === 'bottom');
  topBottomWaistNote(tops, bottoms, lad, notes);
  return notes;
}

// 레이어를 지원하는 FIT MAP 생성(v2.5). 계산 로직 자체는 v2.4와 동일하고,
// 슬롯마다 여러 벌을 순서대로 처리한 뒤 레이어 간 관계를 추가로 판정합니다.
export function buildFitMapLayered(model: FitModel, g: LayeredGarments): FitMap {
  const lad = buildLadder(model);
  const results: FitGarmentResult[] = [];

  const dresses = (g.dresses || []).filter(Boolean);
  if (dresses.length) {
    dresses.forEach((spec, i) => {
      const set = splitSetIfNeeded(spec);
      if (set) {
        // 상하의 세트로 찍힌 한 장 → 상의/하의 두 벌로 쪼개 각각 계산.
        const t = analyzeGarment('top', set[0], model, lad);
        const b = analyzeGarment('bottom', set[1], model, lad);
        t.layerLabel = layerLabelFor('상의', i, dresses.length);
        b.layerLabel = layerLabelFor('하의', i, dresses.length);
        results.push(t, b);
      } else {
        const r = analyzeGarment('dress', spec, model, lad);
        r.layerLabel = layerLabelFor('원피스', i, dresses.length);
        results.push(r);
      }
    });
  } else {
    const tops = (g.tops || []).filter(Boolean);
    const bottoms = (g.bottoms || []).filter(Boolean);
    tops.forEach((spec, i) => {
      const r = analyzeGarment('top', spec, model, lad);
      r.layerLabel = layerLabelFor('상의', i, tops.length);
      results.push(r);
    });
    bottoms.forEach((spec, i) => {
      const r = analyzeGarment('bottom', spec, model, lad);
      r.layerLabel = layerLabelFor('하의', i, bottoms.length);
      results.push(r);
    });
  }

  // 가려지는 항목의 착지점을 "보이지 않음"으로 먼저 바꾼 뒤 관계를 정리합니다(순서 중요).
  const occ = applyOcclusion(results);
  const visibility = occ.notes;
  const relations = layerRelationNotes(results, lad, occ.hemHandled);

  // 액세서리·신발은 겹침 관계 판정 대상이 아니므로 관계 계산 뒤에 덧붙입니다.
  for (const a of (g.accessories || [])) results.push(analyzeWornItem(a, model, lad));
  for (const s of (g.shoes || [])) results.push(analyzeWornItem(s, model, lad));

  return { ladder: ladderOf(lad), garments: results, text: renderFitMapText(results, lad, relations, visibility) };
}

// FIT MAP 텍스트(블록 + 레이어링/가려짐 + 헤더)를 만듭니다. buildFitMapLayered/buildFitMapAuto 공용.
function renderFitMapText(results: FitGarmentResult[], lad: BodyLadder, relations: string[], visibility: string[]): string {
  const ladderStr = ladderOf(lad).map((l) => `${l.name} ${Math.round(l.h)}`).join(' / ');
  const slotLabel: Record<string, string> = {
    top: 'TOP 상의', bottom: 'BOTTOM 하의', dress: 'DRESS 원피스',
    accessory: 'ACCESSORY 액세서리', shoes: 'SHOES 신발',
  };
  const blocks: string[] = [];
  for (const r of results) {
    const head = r.layerLabel ? `${slotLabel[r.slot]} · ${r.layerLabel}` : slotLabel[r.slot];
    const lines = r.rows.map((x) => `- ${x.label}${x.value_cm ? ` ${x.value_cm}` : ''}: ${x.result}`);
    blocks.push(`[${head}] ${r.type}\n${lines.join('\n')}`);
  }
  if (relations.length) {
    blocks.push(`[LAYERING 레이어링·겹침 관계]\n${relations.map((n) => `- ${n}`).join('\n')}`);
  }
  // 가려져 보이지 않는 부분을 따로 명시합니다. 이 블록이 없으면 이미지 모델이 안쪽 옷의
  // 디테일까지 드러내려고 겉옷의 구조(소매 등)를 임의로 바꿔버립니다.
  if (visibility.length) {
    blocks.push(
      `[VISIBILITY 가려짐 — 보이지 않는 부분은 그리지 말 것]\n${visibility.map((n) => `- ${n}`).join('\n')}\n` +
      '- 안쪽 옷의 디테일을 드러내려고 겉옷의 구조(소매를 없애거나 짧게 하기, 트임 만들기 등)를 바꾸는 것은 절대 금지입니다. 겉옷은 자기 사진 그대로의 형태를 유지하고, 안쪽 옷은 가려진 채로 둡니다.',
    );
  }
  return [
    '=== PRE-COMPUTED FIT MAP (정확한 기하로 계산 완료 — 재계산 금지) ===',
    '아래 착지점/여유/실루엣/겹침 관계는 모델 몸과 옷 스펙에서 정확한 뺄셈·나눗셈으로 이미 계산된 확정 사실입니다.',
    '다시 계산하지 말고, 다른 위치로 바꾸지 말고, 이 값을 자연스러운 한국어 피팅 문장으로 옮기기만 하세요.',
    '옷이 여러 겹이면 각 겹(L1=가장 안쪽 → 마지막=가장 바깥)마다 따로 지시를 쓰세요.',
    '',
    `모델 세로 사다리(바닥에서 위로, cm): ${ladderStr}`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

// ===== v2.6: 슬롯을 미리 나누지 않고, 각 옷의 category 판정 결과대로 자동 배치 =====
// buildFitMapLayered와 달리 원피스와 상의(아우터)가 공존할 수 있습니다. 그래서 겹침 판정을
// 슬롯별이 아니라 "상체 스택(원피스+상의)"과 "하체 스택(원피스+하의)"으로 묶어서 수행합니다.
// (원피스는 상·하체를 모두 덮으므로 두 스택에 모두 들어갑니다.)
export function buildFitMapAuto(model: FitModel, g: LayeredGarments): FitMap {
  const lad = buildLadder(model);
  const results: FitGarmentResult[] = [];

  // 처리 순서 = 겹 순서(inner→outer): 원피스 먼저(가장 안쪽), 그다음 업로드 순서의 상의, 그다음 하의.
  const dresses = (g.dresses || []).filter(Boolean);
  const tops = (g.tops || []).filter(Boolean);
  const bottoms = (g.bottoms || []).filter(Boolean);

  const dressResults: FitGarmentResult[] = [];
  dresses.forEach((spec, i) => {
    const set = splitSetIfNeeded(spec);
    if (set) {
      // 세트로 판정된 한 장 → 상의/하의 두 벌로 쪼갬. 세트의 상의는 상체 스택, 하의는 하체 스택.
      const t = analyzeGarment('top', set[0], model, lad);
      const b = analyzeGarment('bottom', set[1], model, lad);
      t.layerLabel = layerLabelFor('상의(세트)', i, dresses.length);
      b.layerLabel = layerLabelFor('하의(세트)', i, dresses.length);
      results.push(t, b);
      dressResults.push(t, b);
    } else {
      const r = analyzeGarment('dress', spec, model, lad);
      r.layerLabel = layerLabelFor('원피스', i, dresses.length);
      results.push(r);
      dressResults.push(r);
    }
  });
  const topResults: FitGarmentResult[] = [];
  tops.forEach((spec, i) => {
    const r = analyzeGarment('top', spec, model, lad);
    r.layerLabel = layerLabelFor('상의', i, tops.length);
    results.push(r);
    topResults.push(r);
  });
  const bottomResults: FitGarmentResult[] = [];
  bottoms.forEach((spec, i) => {
    const r = analyzeGarment('bottom', spec, model, lad);
    r.layerLabel = layerLabelFor('하의', i, bottoms.length);
    results.push(r);
    bottomResults.push(r);
  });

  // 상체 스택(inner→outer): 원피스/세트상의(안쪽) → 상의(바깥). 하체 스택: 원피스/세트하의 → 하의.
  const upperDress = dressResults.filter((r) => r.slot === 'dress' || r.slot === 'top');
  const lowerDress = dressResults.filter((r) => r.slot === 'dress' || r.slot === 'bottom');
  const upperStack = [...upperDress, ...topResults];
  const lowerStack = [...lowerDress, ...bottomResults];

  const visibility: string[] = [];
  const hemHandled = new Set<string>();
  // 소매·상체 가려짐은 상체 스택에서만(하체 스택에 돌리면 "앞여밈 중앙" 같은 상체 전용 문구가 나옴).
  occludeOrderedList(upperStack, visibility, hemHandled);

  const relations: string[] = [];
  hemRelationsOrderedList(upperStack, relations, hemHandled);
  hemRelationsOrderedList(lowerStack, relations, hemHandled);
  // 원피스가 없을 때만 상의↔하의 허리선(넣어/빼) 관계를 답니다(원피스는 허리 이음이 없음).
  if (!dresses.length) topBottomWaistNote(topResults, bottomResults, lad, relations);

  for (const a of (g.accessories || [])) results.push(analyzeWornItem(a, model, lad));
  for (const s of (g.shoes || [])) results.push(analyzeWornItem(s, model, lad));

  return { ladder: ladderOf(lad), garments: results, text: renderFitMapText(results, lad, relations, visibility) };
}
