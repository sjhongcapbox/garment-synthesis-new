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
  required: ['garment_type', 'description', 'measurements'],
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
  measurements: GarmentSpecMeasurement[];
}

// A) 옷 사진 1장 -> 그 옷의 스펙시트 실측(cm) 추정. prompt-garment-analysis.txt 사용.
// analysisModel: 기본 'gemini-3.5-flash'. 'gpt-'로 시작하면 OpenAI Responses API로 태웁니다.
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
          category: { type: 'STRING', description: 'Short Korean category label: 핏, 기장, 소매, 어깨, 넥라인, 허리, 밑단, 레이어링, 실루엣 등.' },
          instruction: { type: 'STRING', description: 'One concrete, visual body-landmark sentence in Korean (한국어).' },
        },
        required: ['garment', 'category', 'instruction'],
      },
    },
  },
  required: ['items'],
};

export interface FittingInstructionItem {
  garment: 'top' | 'bottom' | 'dress' | 'overall';
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
export async function deriveFittingInstructions(opts: {
  modelMeasurementsText: string;
  garmentMeasurementsText: string;
  imagePaths?: string[];
  promptPath?: string;
  model?: string;
}): Promise<FittingInstructionItem[]> {
  const template = fs.readFileSync(opts.promptPath || FITTING_INSTRUCTIONS_PROMPT_PATH, 'utf-8');
  const prompt = template
    .replace(/\{modelMeasurements\}/g, opts.modelMeasurementsText)
    .replace(/\{garmentMeasurements\}/g, opts.garmentMeasurementsText);
  const model = opts.model || GARMENT_ANALYSIS_MODEL;
  const imagePaths = opts.imagePaths ?? [];
  if (model.startsWith('gpt')) {
    const res = await openaiVisionJson<{ items: FittingInstructionItem[] }>({
      prompt, schema: FITTING_INSTRUCTIONS_SCHEMA, schemaName: 'fitting_instructions', imagePaths, model,
    });
    return res.items;
  }
  if (model.startsWith('claude')) {
    const res = await anthropicVisionJson<{ items: FittingInstructionItem[] }>({
      prompt, schema: FITTING_INSTRUCTIONS_SCHEMA, toolName: 'fitting_instructions', imagePaths, model,
    });
    return res.items;
  }
  const res = await geminiJson<{ items: FittingInstructionItem[] }>({
    prompt, schema: FITTING_INSTRUCTIONS_SCHEMA, imagePaths, model,
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
    for (const item of list) out.push(`- ${item.category}: ${item.instruction}`);
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
