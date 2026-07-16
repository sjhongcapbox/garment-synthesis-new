// 모델 사진 위에 상/하의 윤곽선을 얹어 사용자가 직접 메쉬 와프(점을 드래그해서 늘리거나
// 옮기는)로 배치를 조정하는 로컬 테스트 페이지 서버.
//
// 흐름: 모델/상의/하의 이미지 업로드 → [실행] → 서버가 배경 제거된 윤곽선(outline) PNG와
// 둘레를 따라 동간격으로 뽑은 컨트롤 포인트를 만들어 돌려줌 → 브라우저에서 캔버스 위에
// 얹어 점을 드래그하며 조정 → [입히기] → 지금 캔버스에 그려진 상태를 그대로 PNG로 캡처해
// layoutMockupImagePath로 삼아 기존 garment-test.ts 파이프라인(GCP AI Studio 합성)을 그대로 태움.
//
// 사용법: `npx ts-node editor-server.ts` 실행 후 브라우저에서 http://localhost:5177 접속

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import {
  getOutline,
  getTransparentCutout,
  getModelBBox,
  computeRowWidths,
  detectShoulderYFraction,
  detectExistingBottomWaistY,
  parseMeasurementFile,
  CONFIG as MOCKUP_DEFAULTS,
} from './build-mockup';
import { contourPointsFromAlpha } from './contour';
import { runGarmentSynthesisTest, CONFIG as GARMENT_TEST_DEFAULTS } from './garment-test';
import { buildPrompt, uploadImage, requestSynthesis, pollStatus, downloadResult } from './gcp-proxy';
import { openaiSynthesize, tencentSynthesize, isTencentEngine, needsCompactPrompt } from './synth-providers';
import { estimateGarmentLength, analyzeGarmentSpec, deriveFittingInstructions, formatGarmentSpecText, formatFittingInstructionsText, analyzeModelMeasurements, formatModelMeasurementsText } from './gemini-vision';
import { buildFitMap } from './fit-mapper';

const PORT = 5177;
const WORK_DIR = 'C:\\Users\\parra\\Downloads\\fitting';
const TMP_DIR = path.join(WORK_DIR, '_editor_tmp');
// 최종 합성 결과(입히기/운영 피팅샷) 이미지는 원본 업로드/중간 산출물과 섞이지 않도록
// 이 서브폴더에 모아 저장합니다.
const OUTPUT_DIR = path.join(WORK_DIR, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 80 * 1024 * 1024; // base64 사진 3~4장 감안한 넉넉한 한도
const POINT_COUNT = 36; // 윤곽선 둘레를 따라 뽑는 컨트롤 포인트 개수
// 메쉬 편집기/목업(레이아웃 참고용 [IMAGE 4])은 실제 업로드한 모델 사진 대신 이 고정된
// 더미(무표정 마네킹) 위에 옷을 얹습니다. 업로드한 모델 사진은 최종 합성 단계에서
// 얼굴/포즈 소스([IMAGE 1])로만 쓰입니다 — 모델 선택 자체는 그대로 유지됩니다.
const DUMMY_IMAGE_PATH = 'C:\\Users\\parra\\Downloads\\fitting\\dummy.jpg';
// dummy.jpg의 배경은 완전 단색이 아니라 미세한 그라디언트(비네트)라, 모델 사진용 기본
// floodFillThreshold(30)로는 코너에서 시작한 flood-fill이 배경 전체에 다 퍼지지 못하고
// 중간에 멈춰버려 배경 대부분이 "전경"으로 잘못 남습니다(그 결과 bbox가 캔버스 전체로
// 잡혀 px/cm 스케일과 어깨선 검출이 전부 틀어짐). 더미 전용으로 임계값을 훨씬 높게 씁니다.
const DUMMY_FLOOD_FILL_THRESHOLD = 80;
// v2.1/v2.2 전용: 옷마다 실제 기장이 천차만별(반바지/미니스커트/코트/속옷 등)이라, 고정된
// measurement-garment.txt 하나로 모든 옷의 스케일을 잡으면 특히 짧은 옷에서 크게 어긋납니다.
// 업로드된 옷 사진을 즉시 Gemini로 분석해 그 옷에 맞는 기장(cm)을 추정하고, measurements/
// 폴더에 옷마다 별도 파일로 남겨 나중에 확인/디버깅할 수 있게 합니다.
const MEASUREMENTS_DIR = path.join(__dirname, 'measurements');
const RANDOM_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// v2.1 에디터 전용: [참조이미지 만들기]를 누르면 로컬 배경제거 대신 이 프롬프트로
// gcp-proxy를 태워 "모델 체형/포즈에 실제로 입혀진 듯한 옷" 이미지(흰 배경)를 먼저 만들고,
// 그 결과에서 배경만 로컬로 투명화해 메쉬 편집기 소스로 씁니다(텍스처/디테일은 그대로 보존).
const AI_OUTLINE_PROMPT_PATH = path.join(__dirname, 'prompt-ai-outline.txt');
// v2.2 전용: 실제 모델 사진은 자세가 삐딱한(비대칭) 경우가 많아 AI가 그 자세를 잘 못 맞추는
// 문제가 있었습니다. 그래서 v2.2는 항상 똑바로 서 있는 더미(DUMMY_IMAGE_PATH)를 [IMAGE 1]로
// 넘겨 자세 매칭 문제 자체를 피하고, 대신 최종 합성 단계([입히기])에서 실제 모델 사진을
// 다시 사용해 진짜 얼굴/포즈로 입힙니다.
const AI_OUTLINE_DUMMY_PROMPT_PATH = path.join(__dirname, 'prompt-ai-outline-dummy.txt');
const AI_OUTLINE_MODEL = 'gemini-3-pro-image-preview';
const AI_OUTLINE_IMAGE_SIZE = '1K';
// AI가 옷 원본 사진 비율과 무관하게 억지로 캔버스를 꽉 채우려다 옷을 늘리는 것을 막기 위해,
// 옷 원본 사진 자체의 가로세로 비율에 가장 가까운 지원 비율을 골라 요청합니다.
const AI_OUTLINE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2'];

// v2.2 "운영 피팅샷" 버튼 전용: 메쉬 편집기/더미/레이아웃 목업을 전혀 거치지 않고, 모델+상의+하의
// 원본 사진 3장만 바로 AI에 넘겨 한 번에 합성하는 훨씬 단순한 대안 경로입니다.
const PROD_PROMPT_PATH = path.join(__dirname, 'prompt-1-separate.txt');
// 원피스(한 벌) 모드 전용: 상의/하의 모드와는 별개의 모드입니다. 옷 사진을 한 장만 받아
// AI 드레이프/입히기/운영 피팅샷 모두 그 한 장으로 처리합니다.
const DRESS_PROD_PROMPT_PATH = path.join(__dirname, 'prompt-1-dress.txt');
const DRESS_SYNTHESIZE_PROMPT_PATH = path.join(__dirname, 'prompt-2-dress.txt');
// v2.3 전용: 참조이미지(더미 목업)를 폐기하고, 옷 사진에서 추정한 스펙 실측 ↔ 모델 실측을
// 비교해 뽑은 "핏/기장 지시사항"을 텍스트로 프롬프트에 주입해 합성합니다.
const PROMPT_23_PATH = path.join(__dirname, 'prompt-23.txt');
const PROMPT_23_DRESS_PATH = path.join(__dirname, 'prompt-23-dress.txt');
// Kling 등 프롬프트 길이 제한(2500자)이 있는 엔진용 압축 템플릿.
const PROMPT_23_COMPACT_PATH = path.join(__dirname, 'prompt-23-compact.txt');
const PROMPT_23_DRESS_COMPACT_PATH = path.join(__dirname, 'prompt-23-dress-compact.txt');
// v2.4 전용: 옷 cm ↔ 모델 몸 계산을 코드(fit-mapper)가 결정론적으로 수행해 "착지점" FIT MAP을
// 만들고, Function B(prompt-fitting-24)는 그 착지점을 문장화만 합니다. 최종 합성은 prompt-24.
const PROMPT_FITTING_24_PATH = path.join(__dirname, 'prompt-fitting-24.txt');
const PROMPT_24_PATH = path.join(__dirname, 'prompt-24.txt');
const PROMPT_24_DRESS_PATH = path.join(__dirname, 'prompt-24-dress.txt');
const MODEL_MEASUREMENT_PATH = path.join(__dirname, 'measurement-model.txt');

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

interface ParsedDataUrl {
  buffer: Buffer;
  ext: string;
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) throw new Error('이미지 데이터 URL 형식이 아닙니다.');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  return { buffer: Buffer.from(match[2], 'base64'), ext };
}

function saveDataUrlToTmp(dataUrl: string, prefix: string): string {
  const { buffer, ext } = parseDataUrl(dataUrl);
  const filePath = path.join(TMP_DIR, `${prefix}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const buffer = await sharp(filePath).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

interface GarmentExtractResult {
  dataUrl: string; // 배경 제거 + 재색칠된 outline — 메쉬 편집기가 실제로 쓰는 소스
  naturalWidth: number;
  naturalHeight: number;
  points: Array<{ x: number; y: number }>; // 윤곽선 이미지 자체 좌표계 (natural, 안 변함 — 와프의 소스 좌표)
  initX: number; // 모델 이미지 좌표계 기준 초기 배치 left
  initY: number; // 모델 이미지 좌표계 기준 초기 배치 top
  initScale: number; // 초기 배치 스케일 (naturalWidth/Height에 곱하면 초기 표시 크기)
  extractMs: number; // 배경 제거 + 컨트롤 포인트 추출에 걸린 시간(ms)
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

interface OutlinePng {
  outPath: string;
  dataUrl: string;
  width: number;
  height: number;
}

async function makeOutlineOnly(
  localPath: string,
  outPrefix: string,
  lineColor: [number, number, number],
): Promise<OutlinePng> {
  const outPath = path.join(TMP_DIR, `${outPrefix}_${crypto.randomBytes(4).toString('hex')}.png`);
  const outline = await getOutline(
    localPath,
    outPath,
    lineColor,
    MOCKUP_DEFAULTS.lineThicknessFraction,
    MOCKUP_DEFAULTS.fillAlpha,
  );
  const dataUrl = `data:image/png;base64,${outline.buffer.toString('base64')}`;
  return { outPath, dataUrl, width: outline.width, height: outline.height };
}

async function extractGarment(
  localPath: string,
  outPrefix: string,
  lineColor: [number, number, number],
  targetHeightCm: number,
  modelPxPerCm: number,
): Promise<GarmentExtractResult> {
  const outline = await makeOutlineOnly(localPath, outPrefix, lineColor);
  const { data, info } = await sharp(outline.outPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const points = contourPointsFromAlpha(data, info.width, info.height, 10, POINT_COUNT);
  // 실측치(measurement-model.txt/measurement-garment.txt) 기준 실제 cm 길이로 초기 스케일을
  // 잡습니다 — 임의 비율 추정이 아니라 build-mockup.ts와 동일한 방식이라 훨씬 정확합니다.
  const initScale = (targetHeightCm * modelPxPerCm) / outline.height;
  return {
    dataUrl: outline.dataUrl,
    naturalWidth: outline.width,
    naturalHeight: outline.height,
    points,
    initX: 0,
    initY: 0,
    initScale,
    extractMs: 0, // handleExtract에서 실측치로 덮어씁니다
  };
}

function pickAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = AI_OUTLINE_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const ratioStr of AI_OUTLINE_ASPECT_RATIOS) {
    const [w, h] = ratioStr.split(':').map(Number);
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) { bestDiff = diff; best = ratioStr; }
  }
  return best;
}

// gcp-proxy로 프롬프트를 태워, poseImagePath([IMAGE 1] — 실제 모델 사진일 수도, 더미일 수도 있음)의
// 체형/포즈에 실제로 입혀진 듯한 옷([IMAGE 2] 원본 그대로의 디테일 유지) 이미지를 흰 배경으로
// 받아옵니다. promptPath로 어떤 프롬프트(실제 모델용/더미용)를 쓸지 고릅니다.
async function aiDrapeGarment(
  poseImagePath: string,
  garmentPath: string,
  outPrefix: string,
  promptPath: string = AI_OUTLINE_PROMPT_PATH,
): Promise<string> {
  const promptText = fs.readFileSync(promptPath, 'utf-8');
  // 사진 파일 자체의 캔버스 비율이 아니라, 실제 옷이 차지하는 영역(배경 여백 제외)의 비율을
  // 기준으로 골라야 합니다. 옷 주변에 흰 여백이 넉넉한 제품 사진은 캔버스만 보면 실제 옷
  // 모양보다 훨씬 세로로 길어서(예: 거의 정사각형 옷인데 캔버스는 2:3), 그대로 쓰면 엉뚱하게
  // 더 세로로 긴 비율이 선택됩니다.
  const { bbox: garmentBBox } = await getModelBBox(garmentPath, MOCKUP_DEFAULTS.floodFillThreshold);
  const aspectRatio = pickAspectRatio(garmentBBox.width, garmentBBox.height);
  const [modelUrl, garmentUrl] = await Promise.all([uploadImage(poseImagePath), uploadImage(garmentPath)]);
  const job = await requestSynthesis({
    prompt: promptText,
    images: [modelUrl, garmentUrl],
    aspectRatio,
    imageSize: AI_OUTLINE_IMAGE_SIZE,
    model: AI_OUTLINE_MODEL,
  });
  const result = await pollStatus(job.job_id);
  const resultUrl = result.result_urls?.[0] || result.result_url;
  if (!resultUrl) throw new Error(`AI 드레이프 결과 URL이 없습니다: ${JSON.stringify(result)}`);
  const outPath = path.join(TMP_DIR, `${outPrefix}_ai_${crypto.randomBytes(4).toString('hex')}.png`);
  await downloadResult(resultUrl, outPath);
  return outPath;
}

// v2.1 전용: AI 드레이프 이미지를 받아 배경만 로컬로 투명화(실제 텍스처/디테일은 그대로 보존)하고,
// 그 alpha 채널에서 컨트롤 포인트를 뽑습니다. extractGarment()와 반환 형태는 같지만, 옷을
// "평평하게 편 뒤 재색칠한 outline"이 아니라 "AI가 모델 체형/포즈에 맞춰 실제로 그린 사진"을
// 그대로 소스로 씁니다.
async function extractGarmentAi(
  garmentPath: string,
  poseImagePath: string,
  outPrefix: string,
  targetHeightCm: number,
  modelPxPerCm: number,
  promptPath: string = AI_OUTLINE_PROMPT_PATH,
): Promise<GarmentExtractResult> {
  const drapedPath = await aiDrapeGarment(poseImagePath, garmentPath, outPrefix, promptPath);
  const cutoutPath = path.join(TMP_DIR, `${outPrefix}_cutout_${crypto.randomBytes(4).toString('hex')}.png`);
  const cutout = await getTransparentCutout(drapedPath, cutoutPath, MOCKUP_DEFAULTS.floodFillThreshold);
  const { data, info } = await sharp(cutout.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const points = contourPointsFromAlpha(data, info.width, info.height, 10, POINT_COUNT);
  const initScale = (targetHeightCm * modelPxPerCm) / cutout.height;
  return {
    dataUrl: `data:image/png;base64,${cutout.buffer.toString('base64')}`,
    naturalWidth: cutout.width,
    naturalHeight: cutout.height,
    points,
    initX: 0,
    initY: 0,
    initScale,
    extractMs: 0,
  };
}

function randomId6(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += RANDOM_ID_CHARS[crypto.randomInt(RANDOM_ID_CHARS.length)];
  return out;
}

// 업로드된 옷 사진 하나를 Gemini로 즉시 분석해 그 옷에 맞는 실제 착용 기장(cm)을 추정하고,
// measurements/measurement-garment-<난수6자리>.txt로 저장한 뒤 그 값을 반환합니다.
// 분석에 실패하면(네트워크 오류 등) 기존 고정 파일의 값으로 조용히 대체합니다.
async function estimateAndSaveGarmentLength(
  garmentPath: string,
  slot: 'top' | 'bottom' | 'dress',
  modelHeightCm: number,
  fallbackLengthCm: number,
): Promise<number> {
  let lengthCm = fallbackLengthCm;
  let garmentType = '(분석 실패 — 고정값 사용)';
  try {
    const estimate = await estimateGarmentLength(garmentPath, slot, modelHeightCm);
    lengthCm = estimate.total_length_cm;
    garmentType = estimate.garment_type;
  } catch (err) {
    console.error(`옷 기장 자동 분석 실패 (${slot}), 고정값(${fallbackLengthCm}cm)으로 대체:`, (err as Error).message);
  }
  fs.mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const key = slot === 'top' ? 'top_total_length_cm' : slot === 'bottom' ? 'bottom_total_length_cm' : 'dress_total_length_cm';
  const outPath = path.join(MEASUREMENTS_DIR, `measurement-garment-${randomId6()}.txt`);
  fs.writeFileSync(
    outPath,
    `# 자동 분석 (Gemini): ${garmentType}\n# 기준 모델 키: ${modelHeightCm}cm\n${key}: ${lengthCm}\n`,
    'utf-8',
  );
  return lengthCm;
}

async function handleExtractV2(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'v2_model');
  const topPath = saveDataUrlToTmp(body.top, 'v2_top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'v2_bottom');

  // v2(더미 버전)와 달리, v2.1은 실제 업로드된 모델 사진을 기준으로 bbox/어깨선/허리선을
  // 계산합니다 — AI 드레이프 단계에도 이 사진을 그대로 [IMAGE 1]로 넘기므로 일관됩니다.
  const { bbox: modelBBox, rgba: modelRgba } = await getModelBBox(modelPath, MOCKUP_DEFAULTS.floodFillThreshold);
  const rowWidths = computeRowWidths(modelRgba, modelBBox);
  const shoulderYFraction = detectShoulderYFraction(rowWidths, modelBBox.height);
  const shoulderY = modelBBox.minY + modelBBox.height * shoulderYFraction;
  const modelCenterX = modelBBox.minX + modelBBox.width / 2;
  const detectedWaistY = detectExistingBottomWaistY(modelRgba, modelBBox, modelCenterX);
  const waistY = detectedWaistY !== null ? detectedWaistY : shoulderY + modelBBox.height * 0.24;

  const modelMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.modelMeasurementPath);
  const garmentMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.garmentMeasurementPath);
  const modelPxPerCm = modelBBox.height / modelMeasurements.height_cm;

  // 상/하의 AI 드레이프 호출은 서로 독립적이라 병렬로 실행합니다. 기장(cm)은 고정 파일값 대신
  // 업로드된 사진마다 Gemini로 즉시 분석해 그 옷에 맞는 값을 씁니다(반바지/미니스커트/코트 등
  // 기장이 크게 다른 옷도 정확히 스케일되도록).
  const [topTimed, bottomTimed] = await Promise.all([
    timed(async () => {
      const topLengthCm = await estimateAndSaveGarmentLength(topPath, 'top', modelMeasurements.height_cm, garmentMeasurements.top_total_length_cm);
      return extractGarmentAi(topPath, modelPath, 'top', topLengthCm, modelPxPerCm);
    }),
    timed(async () => {
      const bottomLengthCm = await estimateAndSaveGarmentLength(bottomPath, 'bottom', modelMeasurements.height_cm, garmentMeasurements.bottom_total_length_cm);
      return extractGarmentAi(bottomPath, modelPath, 'bottom', bottomLengthCm, modelPxPerCm);
    }),
  ]);
  const top = topTimed.result;
  const bottom = bottomTimed.result;
  top.extractMs = topTimed.ms;
  bottom.extractMs = bottomTimed.ms;

  top.initX = modelCenterX - (top.naturalWidth * top.initScale) / 2;
  top.initY = shoulderY - top.naturalHeight * top.initScale * 0.06;
  bottom.initX = modelCenterX - (bottom.naturalWidth * bottom.initScale) / 2;
  bottom.initY = waistY - bottom.naturalHeight * bottom.initScale * 0.04;

  sendJson(res, 200, {
    modelWidth: modelRgba.width,
    modelHeight: modelRgba.height,
    top,
    bottom,
  });
}

// v2.1 전용: [저장]을 누르면 AI 재합성을 태우지 않고, 지금 캔버스에 그려진 상태(모델 사진 위에
// AI 드레이프 옷을 얹고 사용자가 조정한 결과)를 그대로 최종 피팅샷 이미지로 저장합니다.
async function handleSaveV2(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const { buffer } = parseDataUrl(body.mockup);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUTPUT_DIR, `v2.1_fitting_${timestamp}.png`);
  fs.writeFileSync(outPath, buffer);
  sendJson(res, 200, { savedPath: outPath, resultDataUrl: `data:image/png;base64,${buffer.toString('base64')}` });
}

// v2.2 전용: v2.1처럼 AI 드레이프(실사 텍스처/디테일 보존)를 쓰되, [IMAGE 1]로 실제 업로드한
// 모델 사진 대신 항상 똑바로 서 있는 더미를 넘겨서 "모델이 삐딱하게 서 있으면 AI가 자세를
// 전혀 못 맞추는" 문제를 원천 차단합니다. 업로드한 모델 사진은 여기서는 안 쓰고, 이후
// [입히기]에서 실제 얼굴/포즈 소스로만 사용됩니다(기존 /api/synthesize 그대로 재사용).
async function handleExtractV22(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const topPath = saveDataUrlToTmp(body.top, 'v22_top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'v22_bottom');

  const { bbox: modelBBox, rgba: modelRgba } = await getModelBBox(DUMMY_IMAGE_PATH, DUMMY_FLOOD_FILL_THRESHOLD);
  const rowWidths = computeRowWidths(modelRgba, modelBBox);
  const shoulderYFraction = detectShoulderYFraction(rowWidths, modelBBox.height);
  const shoulderY = modelBBox.minY + modelBBox.height * shoulderYFraction;
  const modelCenterX = modelBBox.minX + modelBBox.width / 2;
  const detectedWaistY = detectExistingBottomWaistY(modelRgba, modelBBox, modelCenterX);
  const waistY = detectedWaistY !== null ? detectedWaistY : shoulderY + modelBBox.height * 0.24;

  const modelMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.modelMeasurementPath);
  const garmentMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.garmentMeasurementPath);
  const modelPxPerCm = modelBBox.height / modelMeasurements.height_cm;

  // 기장(cm)은 고정 파일값 대신 업로드된 사진마다 Gemini로 즉시 분석해 그 옷에 맞는 값을 씁니다
  // (반바지/미니스커트/코트 등 기장이 크게 다른 옷도 정확히 스케일되도록).
  const [topTimed, bottomTimed] = await Promise.all([
    timed(async () => {
      const topLengthCm = await estimateAndSaveGarmentLength(topPath, 'top', modelMeasurements.height_cm, garmentMeasurements.top_total_length_cm);
      return extractGarmentAi(topPath, DUMMY_IMAGE_PATH, 'top', topLengthCm, modelPxPerCm, AI_OUTLINE_DUMMY_PROMPT_PATH);
    }),
    timed(async () => {
      const bottomLengthCm = await estimateAndSaveGarmentLength(bottomPath, 'bottom', modelMeasurements.height_cm, garmentMeasurements.bottom_total_length_cm);
      return extractGarmentAi(bottomPath, DUMMY_IMAGE_PATH, 'bottom', bottomLengthCm, modelPxPerCm, AI_OUTLINE_DUMMY_PROMPT_PATH);
    }),
  ]);
  const top = topTimed.result;
  const bottom = bottomTimed.result;
  top.extractMs = topTimed.ms;
  bottom.extractMs = bottomTimed.ms;

  top.initX = modelCenterX - (top.naturalWidth * top.initScale) / 2;
  top.initY = shoulderY - top.naturalHeight * top.initScale * 0.06;
  bottom.initX = modelCenterX - (bottom.naturalWidth * bottom.initScale) / 2;
  bottom.initY = waistY - bottom.naturalHeight * bottom.initScale * 0.04;

  sendJson(res, 200, {
    modelWidth: modelRgba.width,
    modelHeight: modelRgba.height,
    dummyDataUrl: await fileToDataUrl(DUMMY_IMAGE_PATH),
    top,
    bottom,
  });
}

// v2.2 원피스 모드 전용: handleExtractV22와 동일한 방식(더미 기준 AI 드레이프)이지만 옷을
// 한 장(원피스/점프수트 등 한 벌)만 받습니다. 상의/하의 모드와는 별개의 모드입니다.
async function handleExtractV22Dress(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const dressPath = saveDataUrlToTmp(body.dress, 'v22_dress');

  const { bbox: modelBBox, rgba: modelRgba } = await getModelBBox(DUMMY_IMAGE_PATH, DUMMY_FLOOD_FILL_THRESHOLD);
  const rowWidths = computeRowWidths(modelRgba, modelBBox);
  const shoulderYFraction = detectShoulderYFraction(rowWidths, modelBBox.height);
  const shoulderY = modelBBox.minY + modelBBox.height * shoulderYFraction;
  const modelCenterX = modelBBox.minX + modelBBox.width / 2;

  const modelMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.modelMeasurementPath);
  const garmentMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.garmentMeasurementPath);
  const modelPxPerCm = modelBBox.height / modelMeasurements.height_cm;

  // 원피스는 어깨부터 밑단까지 한 벌로 걸쳐지는 옷이라, 배치는 상의처럼 어깨선을 기준으로 잡습니다.
  const dressTimed = await timed(async () => {
    const dressLengthCm = await estimateAndSaveGarmentLength(dressPath, 'dress', modelMeasurements.height_cm, garmentMeasurements.top_total_length_cm);
    return extractGarmentAi(dressPath, DUMMY_IMAGE_PATH, 'dress', dressLengthCm, modelPxPerCm, AI_OUTLINE_DUMMY_PROMPT_PATH);
  });
  const dress = dressTimed.result;
  dress.extractMs = dressTimed.ms;

  dress.initX = modelCenterX - (dress.naturalWidth * dress.initScale) / 2;
  dress.initY = shoulderY - dress.naturalHeight * dress.initScale * 0.06;

  sendJson(res, 200, {
    modelWidth: modelRgba.width,
    modelHeight: modelRgba.height,
    dummyDataUrl: await fileToDataUrl(DUMMY_IMAGE_PATH),
    dress,
  });
}

async function handleExtract(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const topPath = saveDataUrlToTmp(body.top, 'top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'bottom');

  // 메쉬 편집기 캔버스/목업은 업로드한 모델 사진이 아니라 고정된 더미 위에 옷을 얹으므로,
  // bbox/어깨선/허리선도 더미 기준으로 계산합니다. 업로드한 모델 사진은 여기서는 쓰지 않고
  // 최종 합성(handleSynthesize)에서 얼굴/포즈 소스로만 사용됩니다.
  const { bbox: modelBBox, rgba: modelRgba } = await getModelBBox(DUMMY_IMAGE_PATH, DUMMY_FLOOD_FILL_THRESHOLD);
  const rowWidths = computeRowWidths(modelRgba, modelBBox);
  const shoulderYFraction = detectShoulderYFraction(rowWidths, modelBBox.height);
  const shoulderY = modelBBox.minY + modelBBox.height * shoulderYFraction;
  const modelCenterX = modelBBox.minX + modelBBox.width / 2;
  const detectedWaistY = detectExistingBottomWaistY(modelRgba, modelBBox, modelCenterX);
  const waistY = detectedWaistY !== null ? detectedWaistY : shoulderY + modelBBox.height * 0.24;

  const modelMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.modelMeasurementPath);
  const garmentMeasurements = parseMeasurementFile(GARMENT_TEST_DEFAULTS.garmentMeasurementPath);
  const modelPxPerCm = modelBBox.height / modelMeasurements.height_cm;

  // 로컬 배경 제거 + 컨트롤 포인트 추출뿐이라 AI 호출 없이 빠릅니다. 상/하의는 서로 독립적으로
  // 동시에 처리됩니다.
  const [topTimed, bottomTimed] = await Promise.all([
    timed(() => extractGarment(topPath, 'top_outline', MOCKUP_DEFAULTS.topLineColor, garmentMeasurements.top_total_length_cm, modelPxPerCm)),
    timed(() => extractGarment(bottomPath, 'bottom_outline', MOCKUP_DEFAULTS.bottomLineColor, garmentMeasurements.bottom_total_length_cm, modelPxPerCm)),
  ]);
  const top = topTimed.result;
  const bottom = bottomTimed.result;
  top.extractMs = topTimed.ms;
  bottom.extractMs = bottomTimed.ms;

  // 초기 배치: 상의는 어깨선에 목선이 오도록, 하의는 허리선에 허리밴드가 오도록 대략 중앙 정렬.
  // (사용자가 이후 점을 드래그해서 정밀 조정하는 것이 전제라 대략적인 시작 위치면 충분합니다.)
  top.initX = modelCenterX - (top.naturalWidth * top.initScale) / 2;
  top.initY = shoulderY - top.naturalHeight * top.initScale * 0.06;
  bottom.initX = modelCenterX - (bottom.naturalWidth * bottom.initScale) / 2;
  bottom.initY = waistY - bottom.naturalHeight * bottom.initScale * 0.04;

  sendJson(res, 200, {
    modelWidth: modelRgba.width,
    modelHeight: modelRgba.height,
    dummyDataUrl: await fileToDataUrl(DUMMY_IMAGE_PATH),
    top,
    bottom,
  });
}

async function handleSynthesize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'synth_model');
  const topPath = saveDataUrlToTmp(body.top, 'synth_top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'synth_bottom');
  const mockupPath = saveDataUrlToTmp(body.mockup, 'synth_mockup');

  const result = await runGarmentSynthesisTest({
    ...GARMENT_TEST_DEFAULTS,
    avatarImagePath: modelPath,
    topImagePath: topPath,
    bottomImagePath: bottomPath,
    autoGenerateMockup: false,
    layoutMockupImagePath: mockupPath,
  });

  const resultDataUrls = await Promise.all(result.savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths: result.savedPaths, resultDataUrls });
}

// 원피스 모드의 [입히기] 전용: handleSynthesize와 같은 역할이지만 상의+하의(2장) 대신 원피스
// 한 장 + 레이아웃 목업만 보냅니다. runGarmentSynthesisTest는 상/하의 2장을 전제로 하는
// prompt-2.txt에 고정돼 있어 재사용할 수 없어서, handleSynthesizeProd처럼 gcp-proxy 함수를
// 직접 호출해 prompt-2-dress.txt(모델+원피스+목업 3장)를 태웁니다.
async function handleSynthesizeDress(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'synth_dress_model');
  const dressPath = saveDataUrlToTmp(body.dress, 'synth_dress_dress');
  const mockupPath = saveDataUrlToTmp(body.mockup, 'synth_dress_mockup');

  const prompt = buildPrompt({
    promptTemplatePath: DRESS_SYNTHESIZE_PROMPT_PATH,
    topDescription: GARMENT_TEST_DEFAULTS.topDescription,
    bottomDescription: GARMENT_TEST_DEFAULTS.bottomDescription,
  });
  const [modelUrl, dressUrl, mockupUrl] = await Promise.all([
    uploadImage(modelPath),
    uploadImage(dressPath),
    uploadImage(mockupPath),
  ]);
  const job = await requestSynthesis({
    prompt,
    images: [modelUrl, dressUrl, mockupUrl],
    aspectRatio: GARMENT_TEST_DEFAULTS.aspectRatio,
    imageSize: GARMENT_TEST_DEFAULTS.imageSize,
    model: GARMENT_TEST_DEFAULTS.model,
  });
  const result = await pollStatus(job.job_id);
  const resultUrls = result.result_urls?.length ? result.result_urls : result.result_url ? [result.result_url] : [];
  if (resultUrls.length === 0) {
    throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedPaths: string[] = [];
  for (let i = 0; i < resultUrls.length; i++) {
    const outPath = path.join(OUTPUT_DIR, `dress_fitting_${timestamp}_${i + 1}.png`);
    // eslint-disable-next-line no-await-in-loop
    await downloadResult(resultUrls[i], outPath);
    savedPaths.push(outPath);
  }
  const resultDataUrls = await Promise.all(savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths, resultDataUrls });
}

// "운영 피팅샷" 버튼 전용: 레이아웃 목업([IMAGE 4]) 없이 모델+상의+하의 원본 사진 3장만으로
// prompt-1.txt를 태워 한 번에 합성합니다. runGarmentSynthesisTest/build-mockup을 거치지
// 않는 훨씬 단순한 대안 경로라 gcp-proxy 함수를 직접 호출합니다.
async function handleSynthesizeProd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'prod_model');
  const topPath = saveDataUrlToTmp(body.top, 'prod_top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'prod_bottom');

  const prompt = buildPrompt({
    promptTemplatePath: PROD_PROMPT_PATH,
    topDescription: GARMENT_TEST_DEFAULTS.topDescription,
    bottomDescription: GARMENT_TEST_DEFAULTS.bottomDescription,
  });
  const [modelUrl, topUrl, bottomUrl] = await Promise.all([
    uploadImage(modelPath),
    uploadImage(topPath),
    uploadImage(bottomPath),
  ]);
  const job = await requestSynthesis({
    prompt,
    images: [modelUrl, topUrl, bottomUrl],
    aspectRatio: GARMENT_TEST_DEFAULTS.aspectRatio,
    imageSize: GARMENT_TEST_DEFAULTS.imageSize,
    model: GARMENT_TEST_DEFAULTS.model,
  });
  const result = await pollStatus(job.job_id);
  const resultUrls = result.result_urls?.length ? result.result_urls : result.result_url ? [result.result_url] : [];
  if (resultUrls.length === 0) {
    throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedPaths: string[] = [];
  for (let i = 0; i < resultUrls.length; i++) {
    const outPath = path.join(OUTPUT_DIR, `prod_fitting_${timestamp}_${i + 1}.png`);
    // eslint-disable-next-line no-await-in-loop
    await downloadResult(resultUrls[i], outPath);
    savedPaths.push(outPath);
  }
  const resultDataUrls = await Promise.all(savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths, resultDataUrls });
}

// 원피스 모드의 "운영 피팅샷" 버튼 전용: handleSynthesizeProd와 같은 역할이지만 상의+하의(2장)
// 대신 원피스 한 장만 모델과 함께 보내(총 2장) prompt-1-dress.txt를 태웁니다.
async function handleSynthesizeProdDress(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'prod_dress_model');
  const dressPath = saveDataUrlToTmp(body.dress, 'prod_dress_dress');

  const prompt = buildPrompt({
    promptTemplatePath: DRESS_PROD_PROMPT_PATH,
    topDescription: GARMENT_TEST_DEFAULTS.topDescription,
    bottomDescription: GARMENT_TEST_DEFAULTS.bottomDescription,
  });
  const [modelUrl, dressUrl] = await Promise.all([
    uploadImage(modelPath),
    uploadImage(dressPath),
  ]);
  const job = await requestSynthesis({
    prompt,
    images: [modelUrl, dressUrl],
    aspectRatio: GARMENT_TEST_DEFAULTS.aspectRatio,
    imageSize: GARMENT_TEST_DEFAULTS.imageSize,
    model: GARMENT_TEST_DEFAULTS.model,
  });
  const result = await pollStatus(job.job_id);
  const resultUrls = result.result_urls?.length ? result.result_urls : result.result_url ? [result.result_url] : [];
  if (resultUrls.length === 0) {
    throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedPaths: string[] = [];
  for (let i = 0; i < resultUrls.length; i++) {
    const outPath = path.join(OUTPUT_DIR, `prod_dress_fitting_${timestamp}_${i + 1}.png`);
    // eslint-disable-next-line no-await-in-loop
    await downloadResult(resultUrls[i], outPath);
    savedPaths.push(outPath);
  }
  const resultDataUrls = await Promise.all(savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths, resultDataUrls });
}

// ===== v2.3: 참조이미지(더미 목업) 없이, 옷 스펙 실측 ↔ 모델 실측 비교로 뽑은
// 텍스트 핏/기장 지시사항을 프롬프트에 주입하는 방식. 각 단계 결과를 프론트에서 보고
// 편집할 수 있도록 3개의 독립 엔드포인트로 나눕니다. =====

// 0) 모델 전신 사진 분석 -> 신체 실측 추정. measurements/measurement-model-<난수>.txt로 저장하고
// 구조화된 값을 돌려줘 프론트에서 확인/편집 후 피팅 지시사항 비교에 쓰게 합니다.
async function handleV23AnalyzeModel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const modelPath = saveDataUrlToTmp(body.model, 'v23_model');
  const measurements = await analyzeModelMeasurements(modelPath);
  fs.mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(MEASUREMENTS_DIR, `measurement-model-${randomId6()}.txt`),
    `# 자동 분석 (Gemini, v2.3 모델 체형 분석)\n${formatModelMeasurementsText(measurements)}\n`,
    'utf-8',
  );
  sendJson(res, 200, { model: measurements });
}

// A) 옷 사진(상/하의) 분석 -> 각 옷의 스펙 실측(cm) 텍스트. 병렬. measurements/에도 저장.
async function handleV23AnalyzeGarments(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  fs.mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  const saveSpec = (spec: Awaited<ReturnType<typeof analyzeGarmentSpec>>) => {
    fs.writeFileSync(
      path.join(MEASUREMENTS_DIR, `measurement-garment-${randomId6()}.txt`),
      formatGarmentSpecText(spec) + '\n',
      'utf-8',
    );
  };

  // 한 벌씩(slot: top|bottom) 따로 요청하면, 프론트가 상의/하의 각각의 소요 시간을 재고
  // 먼저 끝난 쪽부터 화면에 그릴 수 있습니다.
  if (body.garment && body.slot) {
    const slot: 'top' | 'bottom' | 'dress' =
      body.slot === 'bottom' ? 'bottom' : body.slot === 'dress' ? 'dress' : 'top';
    const imagePath = saveDataUrlToTmp(body.garment, `v23_${slot}`);
    const spec = await analyzeGarmentSpec(imagePath, slot, body.analysisModel);
    saveSpec(spec);
    sendJson(res, 200, { spec });
    return;
  }

  const topPath = saveDataUrlToTmp(body.top, 'v23_top');
  const bottomPath = saveDataUrlToTmp(body.bottom, 'v23_bottom');

  const [topSpec, bottomSpec] = await Promise.all([
    analyzeGarmentSpec(topPath, 'top'),
    analyzeGarmentSpec(bottomPath, 'bottom'),
  ]);

  saveSpec(topSpec);
  saveSpec(bottomSpec);

  // 구조화된 그대로 돌려줘서 프론트에서 설명 + 항목별 수치로 나눠 보여주고 편집할 수 있게 합니다.
  sendJson(res, 200, { top: topSpec, bottom: bottomSpec });
}

// B) (프론트에서 편집됐을 수 있는) 옷 스펙 텍스트 + 모델 실측 + 옷 이미지(정성적 맥락) ->
// 신체 랜드마크 기준 핏/기장 지시사항 텍스트.
async function handleV23FittingInstructions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  // 프론트의 [모델 체형 분석]에서 추정/편집한 실측을 우선 사용하고, 없으면 고정 파일로 대체.
  const modelMeasurementsText = body.modelSpec
    ? formatModelMeasurementsText(body.modelSpec)
    : fs.readFileSync(MODEL_MEASUREMENT_PATH, 'utf-8');
  const imagePaths: string[] = [];
  // 프론트에서 (편집됐을 수 있는) 구조화된 스펙을 받아 텍스트로 묶습니다.
  // 원피스 모드면 한 벌짜리 스펙만, 상하의 모드면 상의/하의 두 벌을 넣습니다.
  let garmentMeasurementsText: string;
  if (body.dressSpec || body.dress) {
    if (body.dress) imagePaths.push(saveDataUrlToTmp(body.dress, 'v23_ctx_dress'));
    const dressSpecText = body.dressSpec ? formatGarmentSpecText(body.dressSpec) : '(none)';
    garmentMeasurementsText = `ONE-PIECE GARMENT SPEC (dress/jumpsuit, or a matching top+bottom set — set pieces are label-prefixed 상의/하의):\n${dressSpecText}`;
  } else {
    if (body.top) imagePaths.push(saveDataUrlToTmp(body.top, 'v23_ctx_top'));
    if (body.bottom) imagePaths.push(saveDataUrlToTmp(body.bottom, 'v23_ctx_bottom'));
    const topSpecText = body.topSpec ? formatGarmentSpecText(body.topSpec) : '(none)';
    const bottomSpecText = body.bottomSpec ? formatGarmentSpecText(body.bottomSpec) : '(none)';
    garmentMeasurementsText = `TOP GARMENT SPEC:\n${topSpecText}\n\nBOTTOM GARMENT SPEC:\n${bottomSpecText}`;
  }
  const items = await deriveFittingInstructions({
    modelMeasurementsText,
    garmentMeasurementsText,
    imagePaths,
  });
  sendJson(res, 200, { items });
}

// C) 모델+상의+하의 3장 + (편집됐을 수 있는) 핏/기장 지시사항 -> prompt-23으로 최종 합성.
async function handleV23Synthesize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const isDress = Boolean(body.dress);
  const modelPath = saveDataUrlToTmp(body.model, 'v23_synth_model');
  // 원피스 모드는 모델+원피스 2장, 상하의 모드는 모델+상의+하의 3장.
  const garmentPaths = isDress
    ? [saveDataUrlToTmp(body.dress, 'v23_synth_dress')]
    : [saveDataUrlToTmp(body.top, 'v23_synth_top'), saveDataUrlToTmp(body.bottom, 'v23_synth_bottom')];

  // 프론트에서 항목별로 편집된 지시사항(items)을 받아 하나의 텍스트로 묶어 프롬프트에 넣습니다.
  // [핏 지시사항 없이]가 켜지면 지시사항 자리에 빈 값('{}')만 넣습니다(핏 지시 영향 배제 실험용).
  const fittingInstructions = body.noInstructions
    ? '{}'
    : Array.isArray(body.items)
      ? formatFittingInstructionsText(body.items)
      : (body.fittingInstructions || '');
  // 엔진 선택: 기본은 gemini(gcp-proxy). 그 외 gpt-image-2(OpenAI 직접) / 텐센트 MPS(Qwen·Seedream·Kling).
  const engine: string = body.engine || 'gemini';
  // Kling 등 길이 제한 엔진은 압축 프롬프트를 씁니다(그 외는 전체 프롬프트).
  const compact = needsCompactPrompt(engine);
  const promptTemplatePath = isDress
    ? (compact ? PROMPT_23_DRESS_COMPACT_PATH : PROMPT_23_DRESS_PATH)
    : (compact ? PROMPT_23_COMPACT_PATH : PROMPT_23_PATH);
  // 옷 분석에서 뽑은(그리고 사용자가 편집했을 수 있는) 옷 설명을 TEXT_GUIDE로 넣습니다.
  const specDescription = (spec?: { garment_type?: string; description?: string }): string =>
    spec ? [spec.garment_type, spec.description].filter(Boolean).join(' — ') : '';
  const prompt = buildPrompt({
    promptTemplatePath,
    topDescription: (isDress ? specDescription(body.dressSpec) : specDescription(body.topSpec))
      || GARMENT_TEST_DEFAULTS.topDescription,
    bottomDescription: specDescription(body.bottomSpec) || GARMENT_TEST_DEFAULTS.bottomDescription,
    fittingInstructions,
  });
  const localPaths = [modelPath, ...garmentPaths];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeEngine = engine.replace(/[^a-z0-9.-]/gi, '_');
  const savedPaths: string[] = [];

  if (engine.startsWith('gpt-image-2')) {
    // OpenAI는 로컬 이미지 파일을 그대로 multipart로 업로드 (공개 URL 불필요).
    // 엔진 키 접미사로 quality 지정: gpt-image-2-medium / gpt-image-2-high (기본 high).
    const quality: 'medium' | 'high' = engine.endsWith('-medium') ? 'medium' : 'high';
    const buffer = await openaiSynthesize({ imagePaths: localPaths, prompt, quality });
    const outPath = path.join(OUTPUT_DIR, `v23_fitting_${safeEngine}_${timestamp}_1.png`);
    fs.writeFileSync(outPath, buffer);
    savedPaths.push(outPath);
  } else if (isTencentEngine(engine)) {
    // 텐센트 MPS 서버가 참조 이미지를 직접 다운로드하는데, 원본(수 MB)은 다운로드 타임아웃이
    // 납니다. 긴 변 1280px / JPEG 품질 82로 줄인 사본을 업로드해 URL만 넘깁니다.
    const smallPaths = await Promise.all(
      localPaths.map(async (p, i) => {
        const outPath = path.join(TMP_DIR, `v23_tc_${timestamp}_${i}.jpg`);
        await sharp(p).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 }).toFile(outPath);
        return outPath;
      }),
    );
    const imageUrls = await Promise.all(smallPaths.map((p) => uploadImage(p)));
    const resultUrl = await tencentSynthesize({ engine, prompt, imageUrls });
    const outPath = path.join(OUTPUT_DIR, `v23_fitting_${safeEngine}_${timestamp}_1.png`);
    await downloadResult(resultUrl, outPath);
    savedPaths.push(outPath);
  } else {
    // gemini (기존 gcp-proxy 경로)
    const imageUrls = await Promise.all(localPaths.map((p) => uploadImage(p)));
    const job = await requestSynthesis({
      prompt,
      images: imageUrls,
      aspectRatio: GARMENT_TEST_DEFAULTS.aspectRatio,
      imageSize: GARMENT_TEST_DEFAULTS.imageSize,
      model: GARMENT_TEST_DEFAULTS.model,
    });
    const result = await pollStatus(job.job_id);
    const resultUrls = result.result_urls?.length ? result.result_urls : result.result_url ? [result.result_url] : [];
    if (resultUrls.length === 0) throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
    for (let i = 0; i < resultUrls.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `v23_fitting_${safeEngine}_${timestamp}_${i + 1}.png`);
      // eslint-disable-next-line no-await-in-loop
      await downloadResult(resultUrls[i], outPath);
      savedPaths.push(outPath);
    }
  }

  const resultDataUrls = await Promise.all(savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths, resultDataUrls, engine });
}

// ===== v2.4: 옷 cm ↔ 모델 몸 계산을 코드(fit-mapper)가 결정론적으로 수행 =====
// v2.3과 흐름은 같지만, 핏 지시사항 단계에서 raw cm를 LLM에 던지는 대신 fit-mapper가 먼저
// "착지점 FIT MAP"을 계산하고, Function B(prompt-fitting-24)는 그걸 문장화만 합니다.
// 모델 분석/옷 분석 단계는 v2.3 엔드포인트(/api/v23/*)를 그대로 재사용합니다.

// B') (편집됐을 수 있는) 옷 스펙 + 모델 실측 -> 코드가 FIT MAP 계산 -> 선택한 모델로 문장화.
async function handleV24FittingInstructions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.modelSpec) throw new Error('모델 체형 실측(modelSpec)이 필요합니다. 먼저 [모델 체형 분석]을 실행하세요.');
  const modelMeasurementsText = formatModelMeasurementsText(body.modelSpec);

  // 옷 이미지는 정성적 맥락(드레이프/디테일)용으로만 함께 넘깁니다(위치/핏은 FIT MAP이 확정).
  const imagePaths: string[] = [];
  const garments: { top?: any; bottom?: any; dress?: any } = {};
  if (body.dressSpec || body.dress) {
    if (body.dress) imagePaths.push(saveDataUrlToTmp(body.dress, 'v24_ctx_dress'));
    garments.dress = body.dressSpec || null;
  } else {
    if (body.top) imagePaths.push(saveDataUrlToTmp(body.top, 'v24_ctx_top'));
    if (body.bottom) imagePaths.push(saveDataUrlToTmp(body.bottom, 'v24_ctx_bottom'));
    garments.top = body.topSpec || null;
    garments.bottom = body.bottomSpec || null;
  }

  // 1) 코드가 결정론적으로 착지점/여유/실루엣을 계산.
  const fitMap = buildFitMap(body.modelSpec, garments);
  // 2) 선택한 모델(gemini-3.5-flash / gpt-5.6-* / claude-*)로 FIT MAP을 자연스러운 문장으로 변환.
  const items = await deriveFittingInstructions({
    modelMeasurementsText,
    garmentMeasurementsText: fitMap.text,
    imagePaths,
    promptPath: PROMPT_FITTING_24_PATH,
    model: body.fittingModel,
  });
  // fitMap.text는 디버깅용 원문, ladder/garments는 프론트 "착지점 표"용.
  sendJson(res, 200, { items, fitMap: { ladder: fitMap.ladder, garments: fitMap.garments, text: fitMap.text } });
}

// C') 모델+옷 원본 + (편집됐을 수 있는) 지시사항 -> prompt-24로 최종 합성.
// handleV23Synthesize와 동일한 엔진 분기(gemini/gpt-image-2/텐센트)를 쓰되 프롬프트만 prompt-24.
async function handleV24Synthesize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const isDress = Boolean(body.dress);
  const modelPath = saveDataUrlToTmp(body.model, 'v24_synth_model');
  const garmentPaths = isDress
    ? [saveDataUrlToTmp(body.dress, 'v24_synth_dress')]
    : [saveDataUrlToTmp(body.top, 'v24_synth_top'), saveDataUrlToTmp(body.bottom, 'v24_synth_bottom')];

  const fittingInstructions = body.noInstructions
    ? '{}'
    : Array.isArray(body.items)
      ? formatFittingInstructionsText(body.items)
      : (body.fittingInstructions || '');
  const engine: string = body.engine || 'gemini';
  // v2.4 메뉴에는 길이 제한(Kling) 엔진이 없어 항상 전체 프롬프트(prompt-24)를 씁니다.
  const promptTemplatePath = isDress ? PROMPT_24_DRESS_PATH : PROMPT_24_PATH;
  const specDescription = (spec?: { garment_type?: string; description?: string }): string =>
    spec ? [spec.garment_type, spec.description].filter(Boolean).join(' — ') : '';
  const prompt = buildPrompt({
    promptTemplatePath,
    topDescription: (isDress ? specDescription(body.dressSpec) : specDescription(body.topSpec))
      || GARMENT_TEST_DEFAULTS.topDescription,
    bottomDescription: specDescription(body.bottomSpec) || GARMENT_TEST_DEFAULTS.bottomDescription,
    fittingInstructions,
  });
  const localPaths = [modelPath, ...garmentPaths];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeEngine = engine.replace(/[^a-z0-9.-]/gi, '_');
  const savedPaths: string[] = [];

  if (engine.startsWith('gpt-image-2')) {
    const quality: 'medium' | 'high' = engine.endsWith('-medium') ? 'medium' : 'high';
    const buffer = await openaiSynthesize({ imagePaths: localPaths, prompt, quality });
    const outPath = path.join(OUTPUT_DIR, `v24_fitting_${safeEngine}_${timestamp}_1.png`);
    fs.writeFileSync(outPath, buffer);
    savedPaths.push(outPath);
  } else if (isTencentEngine(engine)) {
    const smallPaths = await Promise.all(
      localPaths.map(async (p, i) => {
        const outPath = path.join(TMP_DIR, `v24_tc_${timestamp}_${i}.jpg`);
        await sharp(p).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 }).toFile(outPath);
        return outPath;
      }),
    );
    const imageUrls = await Promise.all(smallPaths.map((p) => uploadImage(p)));
    const resultUrl = await tencentSynthesize({ engine, prompt, imageUrls });
    const outPath = path.join(OUTPUT_DIR, `v24_fitting_${safeEngine}_${timestamp}_1.png`);
    await downloadResult(resultUrl, outPath);
    savedPaths.push(outPath);
  } else {
    const imageUrls = await Promise.all(localPaths.map((p) => uploadImage(p)));
    const job = await requestSynthesis({
      prompt,
      images: imageUrls,
      aspectRatio: GARMENT_TEST_DEFAULTS.aspectRatio,
      imageSize: GARMENT_TEST_DEFAULTS.imageSize,
      model: GARMENT_TEST_DEFAULTS.model,
    });
    const result = await pollStatus(job.job_id);
    const resultUrls = result.result_urls?.length ? result.result_urls : result.result_url ? [result.result_url] : [];
    if (resultUrls.length === 0) throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
    for (let i = 0; i < resultUrls.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `v24_fitting_${safeEngine}_${timestamp}_${i + 1}.png`);
      // eslint-disable-next-line no-await-in-loop
      await downloadResult(resultUrls[i], outPath);
      savedPaths.push(outPath);
    }
  }

  const resultDataUrls = await Promise.all(savedPaths.map((p) => fileToDataUrl(p)));
  sendJson(res, 200, { savedPaths, resultDataUrls, engine });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  // v2.1 에디터(AI 드레이프, 실제 모델 사진 기준)는 /new, v2.2(AI 드레이프 + 더미 + 최종 재합성)는
  // /new2 경로로 접속합니다. 기존 v2(/, /editor.html)는 그대로 둡니다.
  const urlPath =
    req.url === '/' ? '/editor.html' :
    req.url === '/new' ? '/new.html' :
    req.url === '/new2' ? '/new2.html' :
    req.url === '/new23' ? '/new23.html' :
    req.url === '/new24' ? '/new24.html' :
    (req.url || '/editor.html');
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  // 로컬 개발 도구라 코드를 자주 바꾸는데, 캐시 헤더가 없으면 브라우저가 예전 editor.js/html을
  // 계속 재사용해서 "코드는 고쳤는데 화면은 그대로"인 것처럼 보이는 문제가 생깁니다.
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const run = async (): Promise<void> => {
    if (req.method === 'POST' && req.url === '/api/extract') {
      await handleExtract(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/synthesize') {
      await handleSynthesize(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/extract-v2') {
      await handleExtractV2(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/save-v2') {
      await handleSaveV2(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/extract-v22') {
      await handleExtractV22(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/synthesize-prod') {
      await handleSynthesizeProd(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/extract-v22-dress') {
      await handleExtractV22Dress(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/synthesize-dress') {
      await handleSynthesizeDress(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/synthesize-prod-dress') {
      await handleSynthesizeProdDress(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v23/analyze-model') {
      await handleV23AnalyzeModel(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v23/analyze-garments') {
      await handleV23AnalyzeGarments(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v23/fitting-instructions') {
      await handleV23FittingInstructions(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v23/synthesize') {
      await handleV23Synthesize(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v24/fitting-instructions') {
      await handleV24FittingInstructions(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v24/synthesize') {
      await handleV24Synthesize(req, res);
      return;
    }
    // 더미는 절대 안 바뀌니 페이지 로드 시점에 바로 캔버스에 띄울 수 있도록 정적 경로로도
    // 서빙합니다(PUBLIC_DIR 밖에 있는 파일이라 serveStatic으로는 못 받아옵니다).
    if (req.method === 'GET' && req.url === '/dummy.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      fs.createReadStream(DUMMY_IMAGE_PATH).pipe(res);
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  };

  run().catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(PORT, () => {
  console.log(`목업 에디터: http://localhost:${PORT} 에서 접속하세요.`);
});
