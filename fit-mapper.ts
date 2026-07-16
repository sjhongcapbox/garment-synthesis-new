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
}

export interface FitGarmentResult {
  slot: 'top' | 'bottom' | 'dress';
  type: string;
  rows: FitRow[];
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
function findMeasure(list: FitGarmentMeasurement[], keyword: string): number | null {
  const hit = list.find((m) => stripPiece(m.label).includes(keyword));
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
        label: '총장', value_cm: total, kind: 'hem',
        result: `밑단 착지: ${describeBodyHeight(hemH, lad)} (바닥에서 약 ${Math.max(0, Math.round(hemH))}cm, 자연 허리 착용 가정)`,
      });
    } else {
      const hemH = lad.shoulder - total; // 상의/원피스: 어깨에서 아래로
      rows.push({
        label: '총장', value_cm: total, kind: 'hem',
        result: `밑단 착지: ${describeBodyHeight(hemH, lad)} (바닥에서 약 ${Math.max(0, Math.round(hemH))}cm)`,
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
    const verdict = d <= -2 ? '어깨선이 어깨 끝보다 안쪽에 앉음(슬림/드롭 아님)'
      : d < 2 ? '어깨선이 어깨 끝에 딱 맞음(정핏)'
      : '어깨선이 어깨 끝을 넘어감(드롭숄더/오버핏)';
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
      result: `${p.name} 둘레 ${circ} vs 몸 ${p.body} = ${ease >= 0 ? '+' : ''}${ease}cm → ${easeGrade(ease)}${bandNote}`,
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
  if (!hemRow) return null;
  const match = hemRow.result.match(/약 (\d+)cm/);
  const topHemH = match ? Number(match[1]) : null;
  if (topHemH == null) return null;
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
