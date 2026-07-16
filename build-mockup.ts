// 신체/의류 실측치(measurement-model.txt, measurement-garment.txt)를 이용해
// 원본 모델 사진 위에 상/하의를 실제 비율로 얹은 배치 목업을 생성합니다.
// AI 합성용 4번째 참조 이미지(스케일/배치 가이드)로 쓰기 위한 것이라, 상/하의는 실제 사진 대신
// 얇은 회색 윤곽선(outline)만 남겨서 얹습니다. 모델은 원본 사진을 그대로 베이스로 사용합니다.
//
// 파이프라인 (모델/옷 각각 더 신뢰할 수 있는 방법을 하이브리드로 사용):
// - 모델(전신 사진, 세로로 긴 비율)의 어깨/허리선: Gemini에게 직접 물어봤더니 호출마다
//   답이 크게 흔들리고(같은 사진인데 16.7%~29%까지 널뛰기) 실제 격자 눈금으로 확인한
//   정답과도 거리가 멀어서 신뢰할 수 없었음 — 대신 로컬 실루엣 폭-점프 분석(어깨) +
//   torso_length_cm 실측치(허리)로 계산 (아래 detectShoulderYFraction 참고).
// - 하의(정면/평평하게 찍은 단독 제품샷)의 허리밴드 위치: Gemini에게 물어보면 격자로 직접
//   검증해도 정확하고 일관됨 — 제품 사진처럼 단순하고 중앙정렬된 이미지, 그리고 허리밴드처럼
//   사진에 실제로 보이는 부분은 Gemini가 잘 찾음 (gemini-vision.ts).
// - 상의의 "어깨 시접선"은 반대로 시도했다가 뺐습니다: 정면으로 펼쳐 찍은 셔츠 사진에는
//   어깨 시접선이 칼라에 가려 실제로 보이지 않아서 Gemini가 매번 다른 값(25~29%)을
//   추측했고, 그 추측값을 적용하면 모델 사진에서 칼라가 턱까지 올라오는 과도한 보정이
//   나왔습니다. 그래서 상의는 다시 bbox 상단을 어깨선에 직접 맞추는 단순한 방식을 씁니다.
// 1) 모델은 로컬 flood-fill로 bbox(픽셀 신장) + 실루엣 폭 프로파일 계산 (원본 사진은 그대로 유지)
//    상/하의는 실제 bg_remove API로 배경 제거 후 얇은 윤곽선 PNG로 저장 (투명 배경)
// 2) 그 윤곽선 이미지 자체의 가로/세로 픽셀 수 = 실측치(기장 등)에 대응하는 픽셀 길이
// 3) 모델 bbox의 px/cm 스케일을 구하고, 상/하의 윤곽선을 그 스케일에 맞게 리사이즈
// 4) 상의는 bbox 상단을 어깨선에 직접 맞추고, 하의는 Gemini가 찾은 허리밴드 기준점을
//    모델의 허리선에 맞춰 합성
//
// 출력 파일명에는 실행마다 6자리 난수를 붙여서 이전 결과를 덮어쓰지 않습니다.
//
// 사용법: `npx ts-node build-mockup.ts` 실행 → Downloads\fitting\mockup_XXXXXX.png 생성

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { detectBottomGarmentLandmarks } from './gemini-vision';

const WORK_DIR = 'C:\\Users\\parra\\Downloads\\fitting';

export type RGBColor = [number, number, number];

export interface MockupConfig {
  modelImagePath: string;
  topImagePath: string;
  bottomImagePath: string;
  modelMeasurementPath: string;
  garmentMeasurementPath: string;
  outputDir: string;
  outputMaxHeight: number;
  alphaThreshold: number;
  floodFillThreshold: number;
  topLineColor: RGBColor;
  bottomLineColor: RGBColor;
  lineThicknessFraction: number;
  fillAlpha: number;
}

export const CONFIG: MockupConfig = {
  modelImagePath: path.join(WORK_DIR, 'model1.jpg'),
  topImagePath: path.join(WORK_DIR, 't55.png'),
  bottomImagePath: path.join(WORK_DIR, 'b44.png'),
  modelMeasurementPath: path.join(__dirname, 'measurement-model.txt'),
  garmentMeasurementPath: path.join(__dirname, 'measurement-garment.txt'),
  outputDir: WORK_DIR,
  outputMaxHeight: 2000, // 최종 목업 파일의 최대 높이(px). 합성 후 마지막에 리사이즈.
  // 어깨선/허리선(모델)과 어깨시접선/허리밴드(옷)는 Gemini 이미지 이해(gemini-vision.ts)로
  // 자동 검출합니다 — 손으로 맞춘 고정 비율(fraction)을 쓰지 않습니다.
  alphaThreshold: 10, // 이 값보다 alpha가 크면 전경으로 간주 (bg_remove API 결과용)
  floodFillThreshold: 30, // 배경으로 간주할 색상 거리 임계값 (모델 로컬 flood-fill용, 0~441)
  topLineColor: [212, 160, 0], // 상의 윤곽선/채우기 색 (진한 노란색)
  bottomLineColor: [0, 170, 255], // 하의 윤곽선/채우기 색 (형광 파란색)
  lineThicknessFraction: 0.006, // 윤곽선 두께 = 이미지 높이의 이 비율 (해상도가 달라도 두께감이 비슷하도록)
  fillAlpha: 128, // contour 안쪽 채우기 투명도 (0~255, 128 = 약 50%)
};

export interface RGBAImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function makeRunId(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function parseMeasurementFile(filePath: string): Record<string, number> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const values: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(-?\d+(\.\d+)?)/);
    if (match) values[match[1]] = parseFloat(match[2]);
  }
  return values;
}

export async function loadRgba(filePathOrBuffer: string | Buffer): Promise<RGBAImage> {
  const { data, info } = await sharp(filePathOrBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function getAlphaBBox({ data, width, height }: RGBAImage, threshold: number): BBox {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('전경 픽셀을 찾지 못했습니다 (배경 제거 결과가 비어있음).');
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// 배경이 깨끗한(단색) 사진 전용 — 테두리에서 시작하는 flood-fill로 배경 픽셀만 alpha=0 처리.
// data를 직접 수정합니다 (in-place).
function floodFillMakeBackgroundTransparent({ data, width, height }: RGBAImage, threshold: number): void {
  const idx = (x: number, y: number) => (y * width + x) * 4;
  const corners: Array<[number, number]> = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  let br = 0, bg = 0, bb = 0;
  for (const [cx, cy] of corners) {
    const i = idx(cx, cy);
    br += data[i]; bg += data[i + 1]; bb += data[i + 2];
  }
  br /= 4; bg /= 4; bb /= 4;

  const visited = new Uint8Array(width * height);
  const stack: Array<[number, number]> = [];
  for (let x = 0; x < width; x++) { stack.push([x, 0], [x, height - 1]); }
  for (let y = 0; y < height; y++) { stack.push([0, y], [width - 1, y]); }

  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const pos = y * width + x;
    if (visited[pos]) continue;
    visited[pos] = 1;
    const i = pos * 4;
    if (colorDistance(data[i], data[i + 1], data[i + 2], br, bg, bb) > threshold) continue;
    data[i + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

// 마스크 경계(배경과 맞닿는 지점)에서부터 BFS로 거리를 계산해, thicknessPx 이내의
// 전경 픽셀은 선 색(lineColor, 불투명)으로, 그보다 안쪽(contour 내부)은 같은 색의
// 반투명 채우기(fillAlpha)로 칠한 버퍼를 만듭니다. (O(width*height), 두께와 무관)
function buildOutlineRaw(
  { data, width }: RGBAImage,
  bbox: BBox,
  threshold: number,
  lineColor: RGBColor,
  thicknessPx: number,
  fillAlpha: number,
): Uint8ClampedArray {
  const w = bbox.width, h = bbox.height;
  const isBg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcAlpha = data[((bbox.minY + y) * width + (bbox.minX + x)) * 4 + 3];
      isBg[y * w + x] = srcAlpha > threshold ? 0 : 1;
    }
  }

  const dist = new Int16Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let qHead = 0, qTail = 0;
  for (let i = 0; i < w * h; i++) {
    if (isBg[i]) { dist[i] = 0; queue[qTail++] = i; }
  }
  while (qHead < qTail) {
    const pos = queue[qHead++];
    const d = dist[pos];
    const x = pos % w, y = (pos / w) | 0;
    if (x > 0 && dist[pos - 1] === -1) { dist[pos - 1] = d + 1; queue[qTail++] = pos - 1; }
    if (x < w - 1 && dist[pos + 1] === -1) { dist[pos + 1] = d + 1; queue[qTail++] = pos + 1; }
    if (y > 0 && dist[pos - w] === -1) { dist[pos - w] = d + 1; queue[qTail++] = pos - w; }
    if (y < h - 1 && dist[pos + w] === -1) { dist[pos + w] = d + 1; queue[qTail++] = pos + w; }
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (isBg[i] || dist[i] === -1) continue;
    const di = i * 4;
    out[di] = lineColor[0];
    out[di + 1] = lineColor[1];
    out[di + 2] = lineColor[2];
    out[di + 3] = dist[i] <= thicknessPx ? 255 : fillAlpha;
  }
  return out;
}

export interface OutlineResult {
  buffer: Buffer;
  width: number;
  height: number;
  bbox: BBox;
}

interface MakeOutlineParams {
  rgba: RGBAImage;
  outPath: string;
  lineColor: RGBColor;
  thicknessFraction: number;
  fillAlpha: number;
  alphaThreshold?: number;
}

// 배경 제거 + 얇은 윤곽선(투명 배경) PNG를 만들어 저장하고, 그 이미지 자체의 폭/높이(px)와
// bbox(원본 bg_remove 결과 이미지 좌표 기준)를 반환합니다. bbox.minY는 이후 Gemini가 원본
// 이미지 기준으로 알려주는 어깨시접선/허리밴드 좌표를, 이 잘라낸 윤곽선 좌표계로 옮길 때 필요합니다.
async function makeOutline({
  rgba,
  outPath,
  lineColor,
  thicknessFraction,
  fillAlpha,
  alphaThreshold = 1,
}: MakeOutlineParams): Promise<OutlineResult> {
  const bbox = getAlphaBBox(rgba, alphaThreshold);
  const thicknessPx = Math.max(2, Math.round(bbox.height * thicknessFraction));
  const raw = buildOutlineRaw(rgba, bbox, alphaThreshold, lineColor, thicknessPx, fillAlpha);
  const buffer = await sharp(Buffer.from(raw), {
    raw: { width: bbox.width, height: bbox.height, channels: 4 },
  }).png().toBuffer();
  fs.writeFileSync(outPath, buffer);
  return { buffer, width: bbox.width, height: bbox.height, bbox };
}

// alpha 채널에 실제 투명 영역이 일정 비율 이상 있으면 "이미 배경이 제거된 컷아웃 파일"로
// 간주합니다 (단순히 hasAlpha만 보면 알파가 있어도 전부 255(불투명)인 경우를 놓칠 수 있음).
function hasRealTransparency(rgba: RGBAImage, minFraction = 0.01): boolean {
  const { data } = rgba;
  const total = data.length / 4;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) transparent++;
  }
  return transparent / total > minFraction;
}

// 옷 사진이 이미 투명 배경(진짜 alpha 채널)이 있는 컷아웃 파일이면 로컬 alpha를 그대로
// 쓰고, 아니면(배경이 있는 일반 제품샷) 모델 사진과 동일한 방식(모서리 색 기준 flood-fill)으로
// 로컬에서 배경을 투명화합니다. 옷 사진은 대부분 흰/단색 배경 제품샷이라 이 방식으로 충분하고,
// 원격 bg_remove API(업로드+큐 대기+3초 폴링)를 안 태우니 훨씬 빠릅니다.
export async function getOutline(
  localPath: string,
  outPath: string,
  lineColor: RGBColor,
  thicknessFraction: number,
  fillAlpha: number,
  floodFillThreshold: number = 30,
): Promise<OutlineResult> {
  const rgba = await loadRgba(localPath);
  if (!hasRealTransparency(rgba)) {
    floodFillMakeBackgroundTransparent(rgba, floodFillThreshold);
  }
  return makeOutline({ rgba, outPath, lineColor, thicknessFraction, fillAlpha });
}

// getOutline과 달리 선 색으로 다시 칠하지 않고, 배경만 투명화한 뒤 alpha bbox로 타이트하게
// 잘라낸 원본 컬러/텍스처 그대로의 PNG를 만듭니다. AI가 이미 진짜 옷을 그려낸 이미지(흰 배경
// 위에 옷만 있는 결과물)에서 배경만 제거하고 실제 디테일(단추, 칼라 등)은 그대로 보존하고
// 싶을 때 씁니다.
export async function getTransparentCutout(
  localPath: string,
  outPath: string,
  floodFillThreshold: number = 30,
): Promise<OutlineResult> {
  const rgba = await loadRgba(localPath);
  if (!hasRealTransparency(rgba)) {
    floodFillMakeBackgroundTransparent(rgba, floodFillThreshold);
  }
  const bbox = getAlphaBBox(rgba, 1);
  const buffer = await sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .extract({ left: bbox.minX, top: bbox.minY, width: bbox.width, height: bbox.height })
    .png()
    .toBuffer();
  fs.writeFileSync(outPath, buffer);
  return { buffer, width: bbox.width, height: bbox.height, bbox };
}

// 모델은 원본 사진을 그대로 베이스로 쓸 것이므로, 스케일/자세 분석에 필요한
// bounding box + 배경투명화된 rgba(원본 이미지 좌표 기준)를 로컬 flood-fill로 구합니다.
export async function getModelBBox(localPath: string, threshold: number): Promise<{ bbox: BBox; rgba: RGBAImage }> {
  const rgba = await loadRgba(localPath);
  floodFillMakeBackgroundTransparent(rgba, threshold);
  const bbox = getAlphaBBox(rgba, 1);
  return { bbox, rgba };
}

// bbox 내부에서 각 행(y)의 실루엣 폭(가장 왼쪽~오른쪽 전경 픽셀 사이 거리)을 계산합니다.
export function computeRowWidths(rgba: RGBAImage, bbox: BBox): Float64Array {
  const { data, width } = rgba;
  const widths = new Float64Array(bbox.height);
  for (let y = 0; y < bbox.height; y++) {
    const rowY = bbox.minY + y;
    let rMinX = -1, rMaxX = -1;
    for (let x = 0; x < bbox.width; x++) {
      const alpha = data[(rowY * width + (bbox.minX + x)) * 4 + 3];
      if (alpha > 1) {
        if (rMinX === -1) rMinX = x;
        rMaxX = x;
      }
    }
    widths[y] = rMaxX >= 0 ? rMaxX - rMinX + 1 : 0;
  }
  return widths;
}

function movingAverage(arr: Float64Array, windowRadius: number): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(arr.length - 1, i + windowRadius); j++) {
      sum += arr[j]; count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// 어깨선 자동 검출: 머리~목 구간(폭이 좁음)에서 어깨/팔이 붙는 지점(폭이 갑자기 넓어짐)으로
// 넘어가는 변곡점을 찾습니다. 격자 눈금으로 실측 검증한 결과 이 방식이 Gemini의 전신사진
// 좌표 추정보다 정확하고 안정적이었습니다. 반환값은 bbox 높이 대비 비율(0~1)입니다.
export function detectShoulderYFraction(rowWidths: Float64Array, bboxHeight: number): number {
  const smoothRadius = Math.max(3, Math.round(bboxHeight * 0.006));
  const smoothed = movingAverage(rowWidths, smoothRadius);
  const step = Math.max(2, Math.round(bboxHeight * 0.015));
  const searchStart = Math.round(bboxHeight * 0.05);
  const searchEnd = Math.round(bboxHeight * 0.35);
  let bestY = searchStart, bestSlope = -Infinity;
  for (let y = searchStart; y <= searchEnd; y++) {
    const lo = Math.max(0, y - step);
    const hi = Math.min(smoothed.length - 1, y + step);
    const slope = smoothed[hi] - smoothed[lo];
    if (slope > bestSlope) { bestSlope = slope; bestY = y; }
  }
  return bestY / bboxHeight;
}

// 모델이 이미 입고 있는 하의(반바지)의 허리밴드 시작점을 색상 경계로 직접 찾습니다
// (피부색 -> 어두운 색 하의로 바뀌는 지점). "자연스러운 해부학적 허리" 추정치보다
// 실제 사진에 보이는 기준(하이웨스트 여부 등 포함)과 더 잘 맞습니다.
// 모델이 피부와 대비되는 어두운 색 하의를 입고 있을 때만 동작하며, 못 찾으면 null 반환.
export function detectExistingBottomWaistY(rgba: RGBAImage, bbox: BBox, centerX: number): number | null {
  const { data, width } = rgba;
  const searchStart = Math.round(bbox.minY + bbox.height * 0.32);
  const searchEnd = Math.round(bbox.minY + bbox.height * 0.55);
  const halfBand = Math.round(bbox.width * 0.12);
  const cx = Math.round(centerX);
  for (let y = searchStart; y <= searchEnd; y++) {
    let dark = 0, total = 0;
    for (let x = cx - halfBand; x <= cx + halfBand; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 10) continue;
      total++;
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (brightness < 90) dark++;
    }
    if (total > 0 && dark / total > 0.7) return y;
  }
  return null;
}

export async function buildMockup(config: MockupConfig = CONFIG): Promise<string> {
  const model = parseMeasurementFile(config.modelMeasurementPath);
  const garment = parseMeasurementFile(config.garmentMeasurementPath);
  console.log('측정값 확인 (measurement-model.txt / measurement-garment.txt):');
  console.log('  모델:', model);
  console.log('  의류:', garment);

  const runId = makeRunId();
  fs.mkdirSync(config.outputDir, { recursive: true });

  console.log('1) 모델 bbox+실루엣(로컬) + Gemini 하의 랜드마크 검출 + 상/하의 윤곽선 추출...');
  const [modelInfo, bottomGarmentLandmarks, bottomMeta0, topSil, bottomSil] = await Promise.all([
    getModelBBox(config.modelImagePath, config.floodFillThreshold),
    detectBottomGarmentLandmarks(config.bottomImagePath),
    sharp(config.bottomImagePath).metadata(),
    getOutline(
      config.topImagePath,
      path.join(config.outputDir, `_outline_top_${runId}.png`),
      config.topLineColor,
      config.lineThicknessFraction,
      config.fillAlpha,
    ),
    getOutline(
      config.bottomImagePath,
      path.join(config.outputDir, `_outline_bottom_${runId}.png`),
      config.bottomLineColor,
      config.lineThicknessFraction,
      config.fillAlpha,
    ),
  ]);
  const { bbox: modelBBox, rgba: modelRgba } = modelInfo;
  console.log(`   모델 bbox: ${modelBBox.width}x${modelBBox.height}px (원본 사진 내 좌표)`);
  console.log('   하의 랜드마크(정규화 0-1000, 원본 이미지 기준):', bottomGarmentLandmarks);
  console.log(`   상의 윤곽선: ${topSil.width}x${topSil.height}px`);
  console.log(`   하의 윤곽선: ${bottomSil.width}x${bottomSil.height}px`);

  console.log('2) 스케일 계산 (모델 bbox 픽셀 신장 기준) + 어깨선 자동 검출...');
  const modelPxPerCm = modelBBox.height / model.height_cm;
  console.log(`   ${modelBBox.height}px / ${model.height_cm}cm = ${modelPxPerCm.toFixed(2)}px/cm`);
  const rowWidths = computeRowWidths(modelRgba, modelBBox);
  const shoulderYFraction = detectShoulderYFraction(rowWidths, modelBBox.height);
  console.log(`   자동 검출된 어깨선: bbox 상단 기준 ${(shoulderYFraction * 100).toFixed(1)}% 지점`);

  const shoulderY = modelBBox.minY + modelBBox.height * shoulderYFraction;
  const modelCenterX = modelBBox.minX + modelBBox.width / 2;
  // 허리는 폭 프로파일만으로 찾기 어려움(팔이 몸통 옆에 붙어 있으면 팔 폭 때문에 허리
  // 잘록함이 안 보임). 먼저 모델이 이미 입고 있는 하의의 허리밴드를 색상 경계로 직접
  // 찾아보고(하이웨스트 여부 등 실제 스타일링까지 반영되어 더 정확함), 못 찾으면
  // torso_length_cm 실측치로 "검출된 어깨선 + 모델의 실제 몸통 길이"를 계산합니다.
  const existingWaistY = detectExistingBottomWaistY(modelRgba, modelBBox, modelCenterX);
  const waistY = existingWaistY !== null ? existingWaistY : shoulderY + model.torso_length_cm * modelPxPerCm;
  console.log(`   기존 하의 허리밴드 직접 검출: ${existingWaistY !== null ? existingWaistY.toFixed(0) + 'px' : '실패 (torso_length_cm으로 대체)'}`);
  // 상의의 목선(bbox 맨 위)을 어깨선에 그대로 붙이면 목선이 어깨와 같은 높이가 되어
  // 부자연스럽습니다(실제 목선은 어깨선보다 목 쪽으로 살짝 더 높은 곳에 옴). 그래서 목선
  // 기준점은 어깨선보다 neck_height_cm만큼 위로 올립니다.
  const topAnchorY = shoulderY - model.neck_height_cm * modelPxPerCm;
  console.log(`   어깨선: ${shoulderY.toFixed(0)}px, 목선 기준점: ${topAnchorY.toFixed(0)}px (어깨선 - neck_height_cm ${model.neck_height_cm}cm), 허리선: ${waistY.toFixed(0)}px`);

  // 상의는 세로 길이 기준으로만 스케일(원본 종횡비 유지). 소매가 대각선으로 펼쳐진
  // 플랫샷은 몸통과 소매가 이미지 전체에서 분리되지 않아 가로폭 실측치로 강제 맞추면
  // 소매까지 같이 늘어나 망토처럼 퍼지는 문제가 있어, 세로 기준 스케일만 적용합니다.
  console.log('3) 상의는 세로 길이 기준 스케일, 하의는 가로/세로 독립 실측치 기준...');
  const topTargetHeightPx = Math.max(1, Math.round(garment.top_total_length_cm * modelPxPerCm));
  console.log(`   상의: ${garment.top_total_length_cm}cm x ${modelPxPerCm.toFixed(2)}px/cm = ${topTargetHeightPx}px (원본 ${topSil.height}px)`);
  const topResized = await sharp(topSil.buffer).resize({ height: topTargetHeightPx }).toBuffer();
  const topMeta = await sharp(topResized).metadata();

  // bottom_hip_cm은 허리/힙처럼 몸 둘레(circumference) 기준이라, 정면 사진 폭으로 쓰려면 대략 절반으로 환산합니다.
  // (top_chest_width_cm은 애초에 "PIT TO PIT" 평평한 폭으로 정의되어 있어 그대로 사용)
  const bottomTargetHeightPx = Math.max(1, Math.round(garment.bottom_total_length_cm * modelPxPerCm));
  const bottomFrontWidthCm = garment.bottom_hip_cm / 2;
  const bottomTargetWidthPx = Math.max(1, Math.round(bottomFrontWidthCm * modelPxPerCm));
  console.log(`   하의: ${garment.bottom_total_length_cm}cm x ${bottomFrontWidthCm}cm(힙 ${garment.bottom_hip_cm}cm의 절반) → ${bottomTargetWidthPx}x${bottomTargetHeightPx}px (원본 ${bottomSil.width}x${bottomSil.height}px)`);
  const bottomResized = await sharp(bottomSil.buffer)
    .resize({ width: bottomTargetWidthPx, height: bottomTargetHeightPx, fit: 'fill' })
    .toBuffer();
  const bottomMeta = await sharp(bottomResized).metadata();

  // 하의 허리밴드 기준점은 Gemini가 "원본" 하의 사진 기준으로 알려주므로, 배경 제거 후
  // 잘라낸 윤곽선 이미지 좌표계로 옮긴 뒤(- bbox.minY) 리사이즈 배율을 곱해 최종 합성
  // 이미지 안에서의 위치로 변환합니다. 허리밴드는 사진에 실제로 보이는 부분이라
  // Gemini가 안정적으로 잘 찾습니다 (상의의 어깨 시접선과 달리 가려져 있지 않음).
  console.log('4) 하의 허리밴드 기준점 좌표 변환...');
  const bottomScale = bottomTargetHeightPx / bottomSil.height;
  const bottomWaistbandOriginalPx = (bottomGarmentLandmarks.waistband_top_y / 1000) * (bottomMeta0.height as number);
  const bottomWaistbandInResizedPx = (bottomWaistbandOriginalPx - bottomSil.bbox.minY) * bottomScale;
  console.log(`   하의 허리밴드 → 리사이즈 후 이미지 내 ${bottomWaistbandInResizedPx.toFixed(0)}px 지점`);

  console.log('5) 원본 모델 사진 위에 배치 및 합성...');

  const composites = [
    {
      input: topResized,
      left: Math.round(modelCenterX - (topMeta.width as number) / 2),
      top: Math.round(topAnchorY),
    },
    {
      input: bottomResized,
      left: Math.round(modelCenterX - (bottomMeta.width as number) / 2),
      top: Math.round(waistY - bottomWaistbandInResizedPx),
    },
  ];

  const composedBuffer = await sharp(config.modelImagePath)
    .composite(composites)
    .png()
    .toBuffer();
  const outputPath = path.join(config.outputDir, `mockup_${runId}.png`);
  await sharp(composedBuffer)
    .resize({ height: config.outputMaxHeight, withoutEnlargement: true })
    .toFile(outputPath);

  console.log(`완료: ${outputPath}`);
  return outputPath;
}

if (require.main === module) {
  buildMockup().catch((err) => {
    console.error('실패:', err.message);
    process.exit(1);
  });
}
