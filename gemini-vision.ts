// Gemini(이미지 이해)로 모델 사진의 어깨/허리 라인, 의류 사진의 어깨 시접선/허리밴드 위치를
// "찾아서" 반환합니다. 정규화 좌표(0~1000, 0=이미지 상단)로 응답받습니다.
// credentials.local.ts의 geminiApiKey가 필요합니다 (https://aistudio.google.com/apikey 에서 발급).

import * as fs from 'fs';
import * as path from 'path';
import credentials from './credentials.local';
import { openaiVisionJson } from './openai-vision';
import { anthropicVisionJson } from './anthropic-vision';

const GEMINI_MODEL = 'gemini-2.5-flash';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function guessMimeType(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

// 범용 Gemini 호출: 텍스트 프롬프트 + (선택) 여러 이미지 -> responseSchema에 맞는 JSON.
// 이미지 없이 텍스트만 보내는 호출(수치 비교 분석 등)도 지원하며, 모델명을 인자로 받습니다.
export async function geminiJson<T>(opts: {
  prompt: string;
  schema: object;
  imagePaths?: string[];
  model?: string;
}): Promise<T> {
  const { prompt, schema, imagePaths = [], model = GEMINI_MODEL } = opts;
  const key = credentials.geminiApiKey;
  if (!key) throw new Error('credentials.local.ts에 geminiApiKey를 채워주세요 (https://aistudio.google.com/apikey).');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const parts: object[] = [{ text: prompt }];
  for (const imagePath of imagePaths) {
    parts.push({ inline_data: { mime_type: guessMimeType(imagePath), data: fs.readFileSync(imagePath).toString('base64') } });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
    }),
  });
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini 분석 실패 (${model}): ${JSON.stringify(data).slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function analyzeImageJson<T>(imagePath: string, prompt: string, schema: object): Promise<T> {
  return geminiJson<T>({ prompt, schema, imagePaths: [imagePath] });
}

const MODEL_LANDMARKS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    shoulder_line_y: { type: 'INTEGER', description: "Normalized 0-1000 y-coordinate of the top of the shoulders (outer bony point, where a T-shirt's shoulder seam sits)." },
    waist_line_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the natural waistline (narrowest point of the torso).' },
    hip_line_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the widest point of the hips.' },
  },
  required: ['shoulder_line_y', 'waist_line_y', 'hip_line_y'],
};

export interface ModelLandmarks {
  shoulder_line_y: number;
  waist_line_y: number;
  hip_line_y: number;
}

// 모델 사진에서 어깨선/허리선/힙선의 정규화 y좌표(0~1000)를 찾습니다.
export async function detectModelLandmarks(imagePath: string): Promise<ModelLandmarks> {
  const prompt = `This is a full-body photo of a standing fashion model. Analyze her pose and identify these horizontal landmark lines as normalized y-coordinates (0 = top of image, 1000 = bottom of image, integer):
- shoulder_line_y: top of the shoulders (outer bony point, where a T-shirt's shoulder seam sits)
- waist_line_y: natural waistline (narrowest point of the torso, between ribcage and hips)
- hip_line_y: widest point of the hips/pelvis

Return ONLY the JSON matching the schema.`;
  return analyzeImageJson<ModelLandmarks>(imagePath, prompt, MODEL_LANDMARKS_SCHEMA);
}

const TOP_GARMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    shoulder_seam_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the shoulder seam: where the sleeve attaches to the body panel. This is the line that should align with a wearer\'s actual shoulder point when worn.' },
    hem_bottom_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the bottom hem of the garment BODY (not counting sleeves that may hang lower).' },
  },
  required: ['shoulder_seam_y', 'hem_bottom_y'],
};

export interface TopGarmentLandmarks {
  shoulder_seam_y: number;
  hem_bottom_y: number;
}

// 상의 원본(플랫레이) 사진에서 "어깨 시접선"의 정규화 y좌표를 찾습니다.
// (칼라/넥라인 끝은 실제 어깨 시접선보다 위에 있는 경우가 많아, bbox 맨 위를
//  그대로 어깨에 붙이면 옷 전체가 목 쪽으로 밀려 올라가는 문제가 있었음)
export async function detectTopGarmentLandmarks(imagePath: string): Promise<TopGarmentLandmarks> {
  const prompt = `This is a flat-lay/product photo of a top garment (shirt), photographed on a plain background with sleeves laid down beside the body.
Identify these horizontal landmark lines as normalized y-coordinates (0 = top of image, 1000 = bottom of image, integer):
- shoulder_seam_y: the shoulder seam — where the sleeve attaches to the body of the garment
- hem_bottom_y: the bottom hem of the garment body (excluding sleeve overhang)

Return ONLY the JSON matching the schema.`;
  return analyzeImageJson<TopGarmentLandmarks>(imagePath, prompt, TOP_GARMENT_SCHEMA);
}

const BOTTOM_GARMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    waistband_top_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the very top edge of the waistband.' },
    hem_bottom_y: { type: 'INTEGER', description: 'Normalized 0-1000 y-coordinate of the bottom hem of the legs.' },
  },
  required: ['waistband_top_y', 'hem_bottom_y'],
};

export interface BottomGarmentLandmarks {
  waistband_top_y: number;
  hem_bottom_y: number;
}

// 하의 원본(플랫레이) 사진에서 "허리밴드 상단"의 정규화 y좌표를 찾습니다.
export async function detectBottomGarmentLandmarks(imagePath: string): Promise<BottomGarmentLandmarks> {
  const prompt = `This is a flat-lay/product photo of a bottom garment (pants/shorts/skirt), photographed on a plain background.
Identify these horizontal landmark lines as normalized y-coordinates (0 = top of image, 1000 = bottom of image, integer):
- waistband_top_y: the very top edge of the waistband
- hem_bottom_y: the bottom hem of the legs

Return ONLY the JSON matching the schema.`;
  return analyzeImageJson<BottomGarmentLandmarks>(imagePath, prompt, BOTTOM_GARMENT_SCHEMA);
}

const GARMENT_MEASUREMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    garment_type: { type: 'STRING', description: "Specific garment type as actually shown in the photo, e.g. 'button-up shirt', 'cropped t-shirt', 'oversized hoodie', 'trench coat', 'bermuda shorts', 'mini skirt', 'maxi skirt', 'briefs', 'full-length trousers'." },
    total_length_cm: { type: 'NUMBER', description: 'Estimated real-world total worn length in centimeters.' },
  },
  required: ['garment_type', 'total_length_cm'],
};

export interface GarmentMeasurementEstimate {
  garment_type: string;
  total_length_cm: number;
}

// 옷 사진 한 장(상의 또는 하의)을 보고 실제 종류(셔츠/코트/반바지/미니스커트/속옷 등 무엇이든)와
// 실제 착용 기장(cm)을 추정합니다. 고정된 measurement-garment.txt 하나로 모든 옷의 스케일을
// 잡으면 반바지/미니스커트처럼 기장이 아주 짧은 옷에서 크게 어긋나는 문제가 있어, 업로드된
// 사진마다 즉시 분석해서 그 옷에 맞는 값을 씁니다. 모델 키(modelHeightCm)를 기준자로 함께
// 알려줘서 절대적인 cm 단위로 답하게 합니다.
export async function estimateGarmentLength(
  imagePath: string,
  slot: 'top' | 'bottom' | 'dress',
  modelHeightCm: number,
): Promise<GarmentMeasurementEstimate> {
  const anchor = slot === 'top'
    ? "measured from where the shoulder seam sits down to the bottom hem of the garment body (for a cropped top this is short, for a long coat or tunic this is long)"
    : slot === 'bottom'
    ? "measured from the top edge of the waistband down to the bottom hem (for briefs, short shorts, or a mini skirt this is very short — a few tens of cm at most; for a maxi skirt or full-length pants/coat this is long)"
    : "measured from where the shoulder seam sits all the way down to the bottom hem, since it is worn as a single piece from the shoulders (for a mini dress this is short — call it as it is a top-length garment — for a maxi/full-length dress or jumpsuit this is very long, closer to the model's full height)";
  const categoryLabel = slot === 'top' ? 'top' : slot === 'bottom' ? 'bottom' : 'one-piece';
  const categoryExamples = slot === 'top'
    ? 'a cropped top, t-shirt, shirt, sweater, or long coat'
    : slot === 'bottom'
    ? 'briefs, short shorts, a mini skirt, a midi/maxi skirt, or full-length trousers'
    : 'a mini dress, a shirt dress, a maxi/full-length gown, a jumpsuit, or an overall';
  const prompt = `This is a product photo of a single ${categoryLabel} garment. It could be absolutely anything in that category — from ${categoryExamples}. Do not assume a "typical" garment — look carefully at what is actually shown and identify its specific type and cut.

Then estimate its real-world total worn length in centimeters, ${anchor}, as if it were worn by a person who is exactly ${modelHeightCm}cm tall standing normally. Base the estimate on the garment's own visible proportions (relative width/length, how details like buttons, pockets, seams, or the waistband typically scale in real life) and on realistic garment sizing for its specific type — the number must reflect what's actually in the photo, not a generic average. A mini skirt or a pair of briefs should get a small number (roughly 10-40cm); a maxi coat, full-length trousers, or a maxi/full-length dress should get a large number (roughly 90-150cm); a mini dress falls in between (roughly 50-80cm).

Return ONLY the JSON matching the schema.`;
  return analyzeImageJson<GarmentMeasurementEstimate>(imagePath, prompt, GARMENT_MEASUREMENT_SCHEMA);
}

// ===== v2.3 전용: 옷 스펙 추정(A) + 핏/기장 지시사항 도출(B) =====
// 사용자 요청대로 gemini-3.5-flash를 씁니다(gcp-proxy는 이미지 생성 전용이라 텍스트 분석에
// 못 써서, gemini-vision.ts와 동일한 직접 Gemini API 경로로 호출합니다).
const GARMENT_ANALYSIS_MODEL = 'gemini-3.5-flash';
const GARMENT_ANALYSIS_PROMPT_PATH = path.join(__dirname, 'prompt-garment-analysis.txt');
const FITTING_INSTRUCTIONS_PROMPT_PATH = path.join(__dirname, 'prompt-garment-analysis-2.txt');

const GARMENT_SPEC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    garment_type: { type: 'STRING', description: 'Short Korean phrase naming the garment type + fit, e.g. "링거 티셔츠, 레귤러 핏".' },
    description: {
      type: 'STRING',
      description: 'One or two Korean sentences (한국어) describing overall what this garment is — its type, silhouette/fit, fabric feel, and notable design details.',
    },
    design: {
      type: 'STRING',
      description: 'Korean. The garment\'s DESIGN: overall silhouette and shape, neckline/collar shape, closure type (버튼 플라켓, 지퍼, 랩, 풀오버), sleeve shape, and how the panels are cut. Shape only — never say how long or how loose it is.',
    },
    material_color: {
      type: 'STRING',
      description: 'Korean. MATERIAL & COLOR: fabric type/weave, surface texture, sheen (매트/광택), apparent thickness and weight, and the exact colour with tone. End with how the fabric behaves — stiff and structured, or soft and flowing (드레이프). Never give a length or a landing point.',
    },
    details: {
      type: 'STRING',
      description: 'Korean. DETAILS: buttons, pockets, topstitching, cuffs, ribbing, pleats/gathers/shirring, slits, prints, embroidery, labels, trims. State only what is clearly visible in the photo; write "특별한 디테일 없음" if there are none.',
    },
    measurements: {
      type: 'ARRAY',
      description: 'Spec-sheet measurements that actually apply to this garment. Include only relevant ones, in spec-sheet order.',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', description: 'Korean spec label, e.g. "총장", "어깨너비", "가슴단면", "소매길이", "밑위", "인심".' },
          value_cm: { type: 'NUMBER', description: 'Flat measurement in cm for one standard size.' },
          x1: { type: 'INTEGER', description: 'Measurement line start X on the photo, normalized 0-1000.' },
          y1: { type: 'INTEGER', description: 'Measurement line start Y on the photo, normalized 0-1000.' },
          x2: { type: 'INTEGER', description: 'Measurement line end X on the photo, normalized 0-1000.' },
          y2: { type: 'INTEGER', description: 'Measurement line end Y on the photo, normalized 0-1000.' },
        },
        required: ['label', 'value_cm', 'x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  required: ['garment_type', 'description', 'design', 'material_color', 'details', 'measurements'],
};

export interface GarmentSpecMeasurement {
  label: string;
  value_cm: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export interface GarmentSpec {
  garment_type: string;
  description: string;
  // v2.5부터: 외형을 항목별로 나눠 받습니다. 한 문단으로 뭉쳐 두면 이미지 모델이 뒷부분을
  // 흘리고, 사용자도 일부만 고치기 어렵습니다. 핏/기장 칸이 아예 없다는 점이 중요한데,
  // 그쪽은 FIT MAP이 유일한 출처라서 설명이 끼어들면 서로 충돌합니다.
  design?: string;
  material_color?: string;
  details?: string;
  measurements: GarmentSpecMeasurement[];
}

// A) 옷 사진 1장 -> 그 옷의 스펙시트 실측(cm) 추정. prompt-garment-analysis.txt 사용.
// analysisModel: 기본 'gemini-3.5-flash'. 'gpt-'로 시작하면 OpenAI Responses API로 태웁니다.
// ===== v2.6: 슬롯 선택 없이 사진만 보고 옷의 종류(상의/하의/원피스/세트)를 스스로 판정 =====
// 판정 결과(category)에 따라 프론트가 상의/하의/원피스로 자동 분류합니다. 오판이 있을 수 있어
// category는 사용자가 UI에서 고칠 수 있고, 고치면 그 카테고리를 강제해 다시 분석합니다.
export type GarmentCategory = 'top' | 'bottom' | 'dress' | 'set';

const GARMENT_SPEC_AUTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: {
      type: 'STRING',
      enum: ['top', 'bottom', 'dress', 'set'],
      description: 'What this photo shows: "top" = an upper-body garment (shirt, tee, knit, jacket, coat, cardigan). "bottom" = a lower-body garment (pants, skirt, shorts). "dress" = a single one-piece covering torso and legs (dress, jumpsuit, overall). "set" = ONE product photo showing a matching top AND bottom worn/laid together as a coordinated set. Judge by what garment is actually pictured, not by styling.',
    },
    ...GARMENT_SPEC_SCHEMA.properties,
  },
  required: ['category', ...GARMENT_SPEC_SCHEMA.required],
};

export const GARMENT_ANALYSIS_26_PATH = path.join(__dirname, 'prompt-garment-analysis-26.txt');
// v2.7 전용 옷 분석 프롬프트. v2.6과 내용은 같게 시작하지만, 이후 v2.7 분석을 v2.6과 격리해 수정하기 위한 파일.
export const GARMENT_ANALYSIS_27_PATH = path.join(__dirname, 'prompt-garment-analysis-27.txt');

// forcedCategory를 주면(사용자가 뱃지로 카테고리를 고친 경우) 그 종류로 확정하고 측정합니다.
// promptPath로 버전별(-26/-27) 분석 프롬프트를 지정합니다(기본 -26).
export async function analyzeGarmentAuto(
  imagePath: string,
  analysisModel?: string,
  forcedCategory?: GarmentCategory,
  promptPath: string = GARMENT_ANALYSIS_26_PATH,
): Promise<GarmentSpec & { category: GarmentCategory }> {
  const template = fs.readFileSync(promptPath, 'utf-8');
  const forcedNote = forcedCategory
    ? `\n\nThe user has already confirmed this garment's category is "${forcedCategory}". Do NOT re-judge it — set category to exactly "${forcedCategory}" and measure it as that kind of garment.`
    : '';
  const prompt = template.replace(/\{forcedCategory\}/g, forcedNote);
  const model = analysisModel || GARMENT_ANALYSIS_MODEL;
  type R = GarmentSpec & { category: GarmentCategory };
  if (model.startsWith('gpt')) {
    return openaiVisionJson<R>({ prompt, schema: GARMENT_SPEC_AUTO_SCHEMA, schemaName: 'garment_spec_auto', imagePaths: [imagePath], model });
  }
  if (model.startsWith('claude')) {
    return anthropicVisionJson<R>({ prompt, schema: GARMENT_SPEC_AUTO_SCHEMA, toolName: 'garment_spec_auto', imagePaths: [imagePath], model });
  }
  return geminiJson<R>({ prompt, schema: GARMENT_SPEC_AUTO_SCHEMA, imagePaths: [imagePath], model });
}

// ── 자동 그룹핑: 여러 옷 사진 중 "같은 실물 옷의 다른 각도"끼리 묶습니다. ──
// 대표(front) 1장 + 나머지 뷰(back/side)로 그룹을 나눠 프론트가 뷰를 자동 첨부하게 합니다.
const GARMENT_GROUPING_PATH = path.join(__dirname, 'prompt-garment-grouping.txt');

const GARMENT_GROUPING_SCHEMA = {
  type: 'OBJECT',
  properties: {
    groups: {
      type: 'ARRAY',
      description: 'One entry per distinct physical garment. Every input photo index (0..count-1) must appear EXACTLY ONCE across all groups.',
      items: {
        type: 'OBJECT',
        properties: {
          representative_index: { type: 'INTEGER', description: '0-based index of the photo that best shows this garment as a clear, complete FRONT view. Becomes the main card.' },
          view_indices: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Indices of the OTHER photos that are additional angles (back/side/detail) of the SAME physical garment. Empty when the garment has only one photo.' },
          category: { type: 'STRING', enum: ['top', 'bottom', 'dress', 'set'], description: '"top" upper-body, "bottom" lower-body, "dress" one-piece, "set" one photo of a matching top+bottom together. Judge by the representative photo.' },
          reason: { type: 'STRING', description: 'Very short Korean note (e.g. "같은 셔츠 앞/뒤" or, for a single-photo group, the garment name).' },
        },
        required: ['representative_index', 'view_indices', 'category', 'reason'],
      },
    },
  },
  required: ['groups'],
};

export interface GarmentGroup {
  representative_index: number;
  view_indices: number[];
  category: GarmentCategory;
  reason: string;
}

export async function groupGarments(
  imagePaths: string[],
  analysisModel?: string,
): Promise<GarmentGroup[]> {
  const template = fs.readFileSync(GARMENT_GROUPING_PATH, 'utf-8');
  const prompt = template.replace(/\{count\}/g, String(imagePaths.length));
  const model = analysisModel || GARMENT_ANALYSIS_MODEL;
  type R = { groups: GarmentGroup[] };
  let r: R;
  if (model.startsWith('gpt')) {
    r = await openaiVisionJson<R>({ prompt, schema: GARMENT_GROUPING_SCHEMA, schemaName: 'garment_grouping', imagePaths, model });
  } else if (model.startsWith('claude')) {
    r = await anthropicVisionJson<R>({ prompt, schema: GARMENT_GROUPING_SCHEMA, toolName: 'garment_grouping', imagePaths, model });
  } else {
    r = await geminiJson<R>({ prompt, schema: GARMENT_GROUPING_SCHEMA, imagePaths, model });
  }
  return Array.isArray(r.groups) ? r.groups : [];
}

export async function analyzeGarmentSpec(
  imagePath: string,
  garmentCategory: 'top' | 'bottom' | 'dress',
  analysisModel?: string,
): Promise<GarmentSpec> {
  const categoryLabel =
    garmentCategory === 'top' ? 'top garment' :
    garmentCategory === 'bottom' ? 'bottom garment' :
    'one-piece garment (dress/jumpsuit) OR a matching top+bottom set photographed together as one product';
  const template = fs.readFileSync(GARMENT_ANALYSIS_PROMPT_PATH, 'utf-8');
  const prompt = template.replace(/\{garmentCategory\}/g, categoryLabel);
  const model = analysisModel || GARMENT_ANALYSIS_MODEL;
  if (model.startsWith('gpt')) {
    return openaiVisionJson<GarmentSpec>({ prompt, schema: GARMENT_SPEC_SCHEMA, schemaName: 'garment_spec', imagePaths: [imagePath], model });
  }
  if (model.startsWith('claude')) {
    return anthropicVisionJson<GarmentSpec>({ prompt, schema: GARMENT_SPEC_SCHEMA, toolName: 'garment_spec', imagePaths: [imagePath], model });
  }
  return geminiJson<GarmentSpec>({ prompt, schema: GARMENT_SPEC_SCHEMA, imagePaths: [imagePath], model });
}

const FITTING_INSTRUCTIONS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      description: 'One item per distinct fit aspect, split by garment and category.',
      items: {
        type: 'OBJECT',
        properties: {
          garment: { type: 'STRING', enum: ['top', 'bottom', 'dress', 'overall'], description: 'Which garment this instruction is about. Use "dress" for a one-piece garment (dress/jumpsuit).' },
          layer: { type: 'STRING', description: 'When the slot has several layers, the FIT MAP layer label this instruction belongs to, copied EXACTLY as the FIT MAP writes it (e.g. "상의 L1 (이너)", "상의 L2 (겉)"). Use an empty string when the slot has only one garment, or for an "overall" item. One instruction may describe only ONE layer.' },
          category: { type: 'STRING', description: 'Short Korean chip label (2~6 characters) describing THIS specific item, chosen to fit the actual garments — not a fixed generic word. For a single garment aspect use 핏 / 기장 / 소매 / 어깨 / 넥라인 / 허리 / 밑단 / 실루엣. For an "overall" layering/coverage item, name what THIS line is actually about, adapted to the garments involved (e.g. "밑단 겹침", "소매 가려짐", "상하의", "칼라 노출", "허리 정리") — only mention a part that actually exists (never say 소매 for a sleeveless garment). For accessories use "액세서리", for footwear use "신발". Avoid making every layering item the same word.' },
          instruction: { type: 'STRING', description: 'One concrete, visual body-landmark sentence in Korean (한국어).' },
        },
        required: ['garment', 'layer', 'category', 'instruction'],
      },
    },
  },
  required: ['items'],
};

export interface FittingInstructionItem {
  garment: 'top' | 'bottom' | 'dress' | 'overall';
  // 겹이 여러 개인 슬롯에서 이 문장이 어느 겹 이야기인지(FIT MAP 라벨 그대로). 한 겹뿐이거나
  // overall이면 빈 문자열. 이게 없으면 프론트가 여러 겹을 한 묶음에 섞어 보여줍니다.
  layer?: string;
  category: string;
  instruction: string;
}

// B) 모델 실측 + 옷 실측(+선택적으로 옷 이미지) -> 신체 랜드마크 기준 핏/기장 지시사항.
// 상의/하의/전체로 나뉘고 항목(핏·기장·소매·허리 등)별로 쪼개진 구조로 받아서, 프론트에서
// 항목마다 따로 보고 편집할 수 있게 합니다. 옷 이미지는 정성적 맥락(드레이프/실루엣)용으로만
// 쓰고 수치는 절대 덮어쓰지 않도록 prompt-garment-analysis-2.txt에 가드레일이 들어 있습니다.
// v2.4는 promptPath로 다른 템플릿(prompt-fitting-24.txt, 사전 계산 FIT MAP을 문장화)을 주입하고,
// model로 분석 모델(gemini/gpt-5.6/claude)을 골라 쓸 수 있습니다. 둘 다 생략하면 v2.3과 동일하게
// gemini-3.5-flash + prompt-garment-analysis-2.txt로 동작합니다.
// layerLabels를 주면 "layer" 필드를 그 라벨들만 허용하는 enum으로 바꿔서 스키마를 만듭니다.
// 자유 텍스트로 두면 모델이 그냥 빈 문자열을 넣어 버려(실제 발생) 겹별 그룹핑이 무너집니다.
// enum이면 스키마 검증이 유효한 값을 강제하므로, 겹 구분이 모델의 성실성에 의존하지 않습니다.
function fittingSchemaWithLayers(layerLabels?: string[]) {
  if (!layerLabels || layerLabels.length < 2) return FITTING_INSTRUCTIONS_SCHEMA;
  const base = FITTING_INSTRUCTIONS_SCHEMA;
  const itemProps = (base.properties.items as any).items.properties;
  return {
    ...base,
    properties: {
      items: {
        ...(base.properties.items as any),
        items: {
          ...(base.properties.items as any).items,
          properties: {
            ...itemProps,
            layer: {
              type: 'STRING',
              enum: [...layerLabels, ''],
              description: 'Which garment layer this instruction is about. Choose the matching FIT MAP layer label. Use "" only for an item about the whole outfit (레이어링 관계, 액세서리, 신발).',
            },
          },
        },
      },
    },
  };
}

export async function deriveFittingInstructions(opts: {
  modelMeasurementsText: string;
  garmentMeasurementsText: string;
  imagePaths?: string[];
  promptPath?: string;
  model?: string;
  layerLabels?: string[];
}): Promise<FittingInstructionItem[]> {
  const template = fs.readFileSync(opts.promptPath || FITTING_INSTRUCTIONS_PROMPT_PATH, 'utf-8');
  const prompt = template
    .replace(/\{modelMeasurements\}/g, opts.modelMeasurementsText)
    .replace(/\{garmentMeasurements\}/g, opts.garmentMeasurementsText);
  const model = opts.model || GARMENT_ANALYSIS_MODEL;
  const imagePaths = opts.imagePaths ?? [];
  const schema = fittingSchemaWithLayers(opts.layerLabels);
  if (model.startsWith('gpt')) {
    const res = await openaiVisionJson<{ items: FittingInstructionItem[] }>({
      prompt, schema, schemaName: 'fitting_instructions', imagePaths, model,
    });
    return res.items;
  }
  if (model.startsWith('claude')) {
    const res = await anthropicVisionJson<{ items: FittingInstructionItem[] }>({
      prompt, schema, toolName: 'fitting_instructions', imagePaths, model,
    });
    return res.items;
  }
  const res = await geminiJson<{ items: FittingInstructionItem[] }>({
    prompt, schema, imagePaths, model,
  });
  return res.items;
}

// 항목별 지시사항을 최종 합성 프롬프트에 넣을 하나의 텍스트로 묶습니다(상의/하의/전체로 그룹핑).
export function formatFittingInstructionsText(items: FittingInstructionItem[]): string {
  const groups: Array<{ key: FittingInstructionItem['garment']; label: string }> = [
    { key: 'top', label: '상의 (TOP)' },
    { key: 'bottom', label: '하의 (BOTTOM)' },
    { key: 'dress', label: '원피스 (DRESS)' },
    { key: 'overall', label: '전체 / 레이어링 (OVERALL)' },
  ];
  const out: string[] = [];
  for (const group of groups) {
    const list = items.filter((item) => item.garment === group.key);
    if (list.length === 0) continue;
    out.push(`[${group.label}]`);
    // 겹이 여러 개면 겹마다 소제목을 답니다. 문장 자체는 옷 이름을 반복하지 않으므로
    // (그래야 읽기 좋음) 이 소제목이 "어느 옷 이야기인지"를 전달하는 유일한 단서입니다.
    const layers: string[] = [];
    for (const item of list) {
      const key = (item.layer || '').trim();
      if (!layers.includes(key)) layers.push(key);
    }
    const showLayers = layers.filter(Boolean).length > 1;
    for (const layer of layers) {
      const sub = list.filter((item) => (item.layer || '').trim() === layer);
      if (showLayers && layer) out.push(`  <${layer}>`);
      // "전체" 묶음은 겹 라벨이 없으므로 성격(액세서리/신발/겹침)별로 다시 나눠 적습니다.
      // 한 덩어리로 두면 가방·신발·레이어링 지시가 뒤섞여 읽는 쪽이 놓칩니다.
      if (group.key === 'overall' && !layer) {
        const buckets: Array<{ label: string; items: FittingInstructionItem[] }> = [
          { label: '액세서리', items: [] }, { label: '신발', items: [] }, { label: '겹침·레이어링', items: [] },
        ];
        for (const item of sub) {
          const c = item.category || '';
          const i = /액세서리|가방|모자|스카프|목도리|선글라스|벨트|장갑|착용/.test(c) ? 0
            : /신발|슈즈|부츠|굽/.test(c) ? 1 : 2;
          buckets[i].items.push(item);
        }
        for (const b of buckets) {
          if (!b.items.length) continue;
          out.push(`  <${b.label}>`);
          for (const item of b.items) out.push(`- ${item.category}: ${item.instruction}`);
        }
        continue;
      }
      for (const item of sub) out.push(`- ${item.category}: ${item.instruction}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

// 옷 스펙(GarmentSpec)을 measurements 파일 저장 / 다음 단계 프롬프트 주입용 텍스트로 변환.
export function formatGarmentSpecText(spec: GarmentSpec): string {
  const lines = [`# ${spec.garment_type}`];
  if (spec.description) lines.push(`# ${spec.description}`);
  for (const m of spec.measurements) lines.push(`${m.label}: ${m.value_cm} cm`);
  return lines.join('\n');
}

// ===== v2.5 전용: 액세서리 / 신발 한 줄 분류 =====
// 액세서리·신발은 실측(cm)이 핏에 의미가 없어 스펙 분석을 태우지 않습니다. 대신 "무슨
// 아이템이고 몸 어디에 착용하는지"만 짧게 받아 최종 프롬프트의 이미지 매니페스트에 넣어,
// 이미지 모델이 그 사진을 정확히 무엇으로 이해해야 하는지 못박아 줍니다.
const WORN_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: {
      type: 'STRING',
      description: 'Short Korean phrase naming this item including its color/material/type, e.g. "브라운 스웨이드 볼캡", "화이트 레더 스니커즈", "블랙 뿔테 선글라스".',
    },
    description: {
      type: 'STRING',
      description: 'One or two Korean sentences describing the item\'s APPEARANCE so an artist could redraw it: color, material/texture, shape, hardware and closures, straps/laces/soles, pattern or logo, distinctive details. Describe only what is visible. Do not mention size in cm, and do not mention how it is worn.',
    },
    design: {
      type: 'STRING',
      description: 'Korean. The item\'s DESIGN: overall shape and silhouette, structure (구조/실루엣), and its defining form — e.g. a bag\'s body shape and strap configuration, a hat\'s crown and brim shape, a shoe\'s toe shape and sole profile. Shape only, no size in cm.',
    },
    material_color: {
      type: 'STRING',
      description: 'Korean. MATERIAL & COLOR: material (레더/스웨이드/캔버스/울/메탈 등), surface texture, sheen, apparent stiffness, and the exact colour with tone.',
    },
    details: {
      type: 'STRING',
      description: 'Korean. DETAILS: hardware (버클, 지퍼, 체인, 링, 스터드), stitching, laces, soles, linings, logos, prints, trims. State only what is clearly visible; write "특별한 디테일 없음" if there are none.',
    },
    worn_on: {
      type: 'STRING',
      description: 'Where on the body it is worn, as a short Korean word: 머리, 얼굴, 목, 어깨, 손, 손목, 허리, 발 등.',
    },
    wear_style: {
      type: 'STRING',
      description: 'The most natural way THIS item is carried/worn, in Korean. For bags choose exactly one of: 어깨에 메기 / 크로스로 메기 / 팔(팔꿈치)에 걸기 / 손에 들기 / 등에 메기(백팩). For a hat: 머리에 착용. For a scarf: 목에 두르기 / 어깨에 걸치기. For glasses: 얼굴에 착용. For shoes or anything else: 자연스럽게 착용.',
    },
    measurements: {
      type: 'ARRAY',
      description: 'Size measurements that actually matter for drawing this item at the correct scale on a person. Return an EMPTY array for items whose size does not meaningfully change how they are drawn (sunglasses, belts, gloves, jewelry, plain socks).',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', description: 'Korean measurement label, chosen from the vocabulary given in the prompt.' },
          value_cm: { type: 'NUMBER', description: 'Estimated real-world measurement in cm.' },
          x1: { type: 'INTEGER', description: 'Measurement line start X on the photo, normalized 0-1000.' },
          y1: { type: 'INTEGER', description: 'Measurement line start Y on the photo, normalized 0-1000.' },
          x2: { type: 'INTEGER', description: 'Measurement line end X on the photo, normalized 0-1000.' },
          y2: { type: 'INTEGER', description: 'Measurement line end Y on the photo, normalized 0-1000.' },
        },
        required: ['label', 'value_cm', 'x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  required: ['name', 'description', 'design', 'material_color', 'details', 'worn_on', 'wear_style', 'measurements'],
};

export interface WornItem {
  name: string;
  // 외형 한두 문장(색·소재·형태·하드웨어·디테일). 옷과 마찬가지로 GARMENT DESCRIPTION에
  // 들어가며, 여기가 비어 있으면 이미지 모델이 액세서리 외형을 사진에서만 추측하게 됩니다.
  description: string;
  design?: string;
  material_color?: string;
  details?: string;
  worn_on: string;
  // 착용/착장 방법. 같은 가방도 어깨/크로스/팔걸이/손에 들기에 따라 그림이 완전히 달라지고,
  // 스트랩 드롭을 어떻게 해석할지도 여기에 종속됩니다. AI가 제안하고 사용자가 바꿉니다.
  wear_style: string;
  measurements: GarmentSpecMeasurement[];
}

// 액세서리/신발은 옷과 달리 "핏"이 아니라 **스케일**이 문제입니다. 제품 사진은 미니백이든
// 대형 토트든 프레임을 꽉 채우게 찍히므로, 이미지 모델이 크기를 짐작하다 자주 틀립니다.
// 그래서 아이템 종류에 맞는 최소한의 실측만 뽑아, 나중에 fit-mapper가 "모델 몸 기준 상대
// 크기 / 어디에 걸리는지"로 환산합니다. 크기가 그림에 영향을 주지 않는 아이템(선글라스,
// 벨트, 장갑, 주얼리)은 측정을 생략합니다.
export async function classifyWornItem(
  imagePath: string,
  kind: 'accessory' | 'shoes',
  analysisModel?: string,
): Promise<WornItem> {
  const what = kind === 'shoes'
    ? 'a pair of shoes, boots, sandals, or socks'
    : 'a fashion accessory (hat, cap, scarf, muffler, sunglasses, glasses, handbag, backpack, belt, gloves, jewelry, etc.)';
  const vocab = kind === 'shoes'
    ? `- Boots (any shaft height): 목높이 (shaft height from the ground/ankle up to the top opening of the boot), 굽높이 (heel height)
- Heels / pumps / sandals with a raised heel: 굽높이
- Flat sneakers, loafers, flats, plain socks: return an EMPTY measurements array (their size does not change how they are drawn)`
    : `- 가방 (handbag, tote, shoulder bag, crossbody, backpack): 가로 (widest width of the bag body), 세로 (height of the bag body), 폭 (depth/thickness), 스트랩드롭 (strap drop — the vertical distance from where the strap sits on the shoulder down to the TOP of the bag body when carried; estimate it from the strap length shown)
- 모자 (hat, cap, bucket hat): 챙너비 (total brim width across), 크라운높이 (crown height)
- 스카프 / 머플러 / 숄: 길이 (total length), 폭 (width)
- 선글라스, 안경, 벨트, 장갑, 주얼리, 시계: return an EMPTY measurements array`;
  const prompt = `This product photo shows ${what}. It may be photographed alone, on a plain background, or worn by an unrelated person — identify ONLY the item itself, ignoring any person, hanger, or background.

Return:
- name: a short Korean phrase naming the item with its color and material (e.g. "브라운 스웨이드 볼캡", "화이트 레더 스니커즈"). Be specific about what is actually shown.
- description: one or two Korean sentences summarising how the item LOOKS at a glance, so a person can confirm the AI understood the item.
- design: its DESIGN — overall shape and structure, and the form that defines it (a bag's body shape and strap configuration, a hat's crown and brim shape, a shoe's toe shape and sole profile). Shape only.
- material_color: its MATERIAL and COLOR — 레더 / 스웨이드 / 캔버스 / 울 / 니트 / 메탈 등, surface texture, sheen, how stiff or soft it looks, and the exact colour with its tone.
- details: the DETAILS — hardware (버클, 지퍼, 체인, 링, 스터드), stitching, laces, soles, linings, logos, prints, trims. Only what is clearly visible; write "특별한 디테일 없음" if there are none.

Keep size (cm) and carrying method out of design/material_color/details — both are separate fields below, and repeating them there creates conflicting instructions.

- worn_on: the single body part where this item is worn, in Korean (머리 / 얼굴 / 목 / 어깨 / 손 / 손목 / 허리 / 발 …).
- wear_style: how this specific item is most naturally carried or worn. For a bag, judge from its form — a backpack goes 등에 메기(백팩), a clutch or a bag with no strap goes 손에 들기, a long-strap bag goes 크로스로 메기, a short-handled tote goes 어깨에 메기 or 팔(팔꿈치)에 걸기. Pick exactly one from the list in the schema.
- measurements: ONLY the measurements listed below for this item's type, estimated in real-world centimeters. Use these exact Korean labels:
${vocab}

Base every number on the item's own visible proportions and on realistic sizing for that specific item type — a mini bag is roughly 15-20cm wide, a large tote 40-50cm; an ankle boot's 목높이 is roughly 10-15cm, a knee-high boot 35-40cm. Read the actual item in the photo.

For EACH measurement, also give where it is taken on this photo as a straight line: endpoints x1,y1 → x2,y2 in normalized image coordinates (integers 0-1000, where 0,0 is the photo's top-left and 1000,1000 its bottom-right). Place each line accurately on the item as it appears in THIS photo. (For 스트랩드롭, draw the line along the hanging strap from its top down to the top edge of the bag body.)

Return ONLY the structured data requested.`;
  const model = analysisModel || GARMENT_ANALYSIS_MODEL;
  if (model.startsWith('gpt')) {
    return openaiVisionJson<WornItem>({ prompt, schema: WORN_ITEM_SCHEMA, schemaName: 'worn_item', imagePaths: [imagePath], model });
  }
  if (model.startsWith('claude')) {
    return anthropicVisionJson<WornItem>({ prompt, schema: WORN_ITEM_SCHEMA, toolName: 'worn_item', imagePaths: [imagePath], model });
  }
  return geminiJson<WornItem>({ prompt, schema: WORN_ITEM_SCHEMA, imagePaths: [imagePath], model });
}

// ===== v2.3 전용: 모델 사진에서 신체 실측(measurement-model.txt와 같은 키) 추정 =====
const MODEL_ANALYSIS_PROMPT_PATH = path.join(__dirname, 'prompt-model-analysis.txt');

const MODEL_MEASUREMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    height_cm: { type: 'NUMBER' },
    weight_kg: { type: 'NUMBER' },
    shoulder_width_cm: { type: 'NUMBER' },
    chest_cm: { type: 'NUMBER' },
    waist_cm: { type: 'NUMBER' },
    hip_cm: { type: 'NUMBER' },
    arm_length_cm: { type: 'NUMBER' },
    torso_length_cm: { type: 'NUMBER' },
    leg_length_cm: { type: 'NUMBER' },
    // 모델 사진 위 측정선(작업지시서식 화살표 표기용). 화면 표시 전용.
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          value_cm: { type: 'NUMBER' },
          x1: { type: 'INTEGER' },
          y1: { type: 'INTEGER' },
          x2: { type: 'INTEGER' },
          y2: { type: 'INTEGER' },
        },
        required: ['label', 'value_cm', 'x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  required: ['height_cm', 'weight_kg', 'shoulder_width_cm', 'chest_cm', 'waist_cm', 'hip_cm', 'arm_length_cm', 'torso_length_cm', 'leg_length_cm', 'lines'],
};

export interface ModelMeasurementLine {
  label: string;
  value_cm: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ModelMeasurements {
  height_cm: number;
  weight_kg: number;
  shoulder_width_cm: number;
  chest_cm: number;
  waist_cm: number;
  hip_cm: number;
  arm_length_cm: number;
  torso_length_cm: number;
  leg_length_cm: number;
  lines?: ModelMeasurementLine[];
}

// 모델 전신 사진 1장 -> 신체 실측 추정. measurement-model.txt와 동일한 키를 쓰므로
// 그대로 파일로 저장하거나 피팅 지시사항 비교 입력으로 쓸 수 있습니다.
export async function analyzeModelMeasurements(imagePath: string): Promise<ModelMeasurements> {
  const prompt = fs.readFileSync(MODEL_ANALYSIS_PROMPT_PATH, 'utf-8');
  return geminiJson<ModelMeasurements>({ prompt, schema: MODEL_MEASUREMENT_SCHEMA, imagePaths: [imagePath], model: GARMENT_ANALYSIS_MODEL });
}

// 모델 실측을 measurement-model.txt와 같은 "key: value" 형식 텍스트로 변환.
export function formatModelMeasurementsText(m: ModelMeasurements): string {
  return [
    `height_cm: ${m.height_cm}`,
    `weight_kg: ${m.weight_kg}`,
    `shoulder_width_cm: ${m.shoulder_width_cm}`,
    `chest_cm: ${m.chest_cm}`,
    `waist_cm: ${m.waist_cm}`,
    `hip_cm: ${m.hip_cm}`,
    `arm_length_cm: ${m.arm_length_cm}`,
    `torso_length_cm: ${m.torso_length_cm}`,
    `leg_length_cm: ${m.leg_length_cm}`,
  ].join('\n');
}
