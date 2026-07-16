// 피팅샷 합성 대체 엔진들. 기본(gemini)은 gcp-proxy를 그대로 쓰고, 여기서는 그 외의
// 엔진 두 갈래를 제공합니다:
//   1) OpenAI gpt-image-2  — POST /v1/images/edits (multipart), 로컬 이미지 파일을 직접 업로드
//   2) 텐센트 MPS AIGC     — Qwen / Seedream / Kling. 공개 URL(ImageInfos)로 참조 이미지를 넘기고
//      CreateAigcImageTask → DescribeAigcImageTask 폴링. (style-room-api tencent-test 패턴 이식)
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import credentials from './credentials.local';

// 프론트에서 고르는 엔진 키. 기본 gemini / gpt-image-2(OpenAI 직접) 외에는 텐센트 MPS 모델 키.
export type SynthEngine = string;

// 텐센트 MPS 모델은 (ModelName, ModelVersion) 쌍으로 지정합니다. (ai-studio-admin 모델표 기준
// 이미지 생성 가능한 모델 전체) GPT-Image2는 OpenAI 직접 경로('gpt-image-2')로 따로 처리합니다.
const TENCENT_MODELS: Record<string, { modelName: string; modelVersion: string }> = {
  'kling-2.1': { modelName: 'Kling', modelVersion: '2.1' },
  'kling-3.0': { modelName: 'Kling', modelVersion: '3.0' },
  'kling-3.0-omni': { modelName: 'Kling', modelVersion: '3.0-Omni' },
  'kling-o1': { modelName: 'Kling', modelVersion: 'O1' },
  'seedream-4.5': { modelName: 'Seedream', modelVersion: '4.5' },
  'seedream-5.0-lite': { modelName: 'Seedream', modelVersion: '5.0-lite' },
  'qwen': { modelName: 'Qwen', modelVersion: '0925' },
  'og-medium': { modelName: 'OG', modelVersion: 'image2_medium' },
  'og-high': { modelName: 'OG', modelVersion: 'image2_high' },
};

export function isTencentEngine(engine: string): engine is SynthEngine {
  return engine in TENCENT_MODELS;
}

// Kling은 프롬프트 최대 2500자 제한이 있어(ret:1201), 짧은 압축 템플릿을 써야 합니다.
// (Seedream/Qwen/GPT/Gemini는 긴 프롬프트를 그대로 받습니다.)
export function needsCompactPrompt(engine: string): boolean {
  return engine.startsWith('kling');
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// ─────────────────────────────────────────────────────────────
// 1) OpenAI gpt-image-2 (images/edits, multipart)
// ─────────────────────────────────────────────────────────────
const OPENAI_IMAGE_MODEL = 'gpt-image-2-2026-04-21';
const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';

// imagePaths: [모델, 상의, 하의] (또는 [모델, 원피스]) 순서. 첫 장이 편집 대상, 나머지는 참조로
// 함께 올라갑니다. 반환은 PNG 버퍼(첫 결과).
export async function openaiSynthesize(opts: {
  imagePaths: string[];
  prompt: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
}): Promise<Buffer> {
  const key = credentials.openaiApiKey;
  if (!key) throw new Error('.env에 OPENAI_API_KEY를 채워주세요.');

  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('prompt', opts.prompt);
  form.append('size', opts.size || '1024x1536');
  form.append('output_format', 'png');
  form.append('quality', opts.quality || 'high');
  form.append('n', '1');
  for (const p of opts.imagePaths) {
    if (!fs.existsSync(p)) throw new Error(`이미지 파일을 찾을 수 없습니다: ${p}`);
    const blob = new Blob([fs.readFileSync(p)], { type: guessMime(p) });
    form.append('image[]', blob, path.basename(p));
  }

  const res = await fetch(OPENAI_EDITS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI 이미지 편집 실패 (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI 응답에 이미지가 없습니다: ${JSON.stringify(data).slice(0, 300)}`);
  return Buffer.from(b64, 'base64');
}

// ─────────────────────────────────────────────────────────────
// 2) 텐센트 MPS AIGC (TC3-HMAC-SHA256 서명 → CreateAigcImageTask → 폴링)
//    style-room-api/src/apis/tencent-test/tencent-test.service.ts 서명 로직 이식.
// ─────────────────────────────────────────────────────────────
const MPS_HOST = 'mps.intl.tencentcloudapi.com';
const MPS_VERSION = '2019-06-12';
const MPS_REGION = 'ap-seoul';
const TENCENT_POLL_INTERVAL_MS = 3000;
// 계정 동시 실행 제한(RequestLimitExceeded) 때문에 여러 태스크가 큐에서 대기할 수 있어
// 넉넉히 잡습니다(생성 대기 + 실제 생성).
const TENCENT_POLL_TIMEOUT_MS = 12 * 60 * 1000;
// CreateAigcImageTask가 동시 실행 제한에 걸리면 슬롯이 날 때까지 재시도합니다.
const TENCENT_CREATE_MAX_WAIT_MS = 8 * 60 * 1000;
const TENCENT_CREATE_RETRY_MS = 8000;

function sha256hex(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function buildTencentAuth(body: string): { Authorization: string; timestamp: string } {
  const service = 'mps';
  const algorithm = 'TC3-HMAC-SHA256';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];

  const canonicalHeaders = `content-type:application/json\nhost:${MPS_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [algorithm, String(timestamp), credentialScope, sha256hex(canonicalRequest)].join('\n');

  const secretDate = hmac(Buffer.from('TC3' + credentials.tencentSecretKey, 'utf8'), date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');

  const authorization = `${algorithm} Credential=${credentials.tencentSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { Authorization: authorization, timestamp: String(timestamp) };
}

async function callMps(action: string, params: object): Promise<any> {
  if (!credentials.tencentSecretId || !credentials.tencentSecretKey) {
    throw new Error('.env에 TENCENT_SECRET_ID / TENCENT_SECRET_KEY를 채워주세요.');
  }
  const body = JSON.stringify(params);
  const auth = buildTencentAuth(body);
  const res = await fetch(`https://${MPS_HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth.Authorization,
      'X-TC-Action': action,
      'X-TC-Version': MPS_VERSION,
      'X-TC-Region': MPS_REGION,
      'X-TC-Timestamp': auth.timestamp,
    },
    body,
  });
  const data: any = await res.json();
  if (data?.Response?.Error) {
    const { Code, Message } = data.Response.Error;
    throw new Error(`텐센트 MPS [${action}] 오류: [${Code}] ${Message}`);
  }
  return data.Response;
}

// imageUrls: 공개 접근 가능한 참조 이미지 URL 목록([모델, 상의, 하의] 순). 반환은 결과 이미지 URL.
export async function tencentSynthesize(opts: {
  engine: string;
  prompt: string;
  imageUrls: string[];
  size?: string;
}): Promise<string> {
  const model = TENCENT_MODELS[opts.engine];
  if (!model) throw new Error(`알 수 없는 텐센트 엔진: ${opts.engine}`);

  // 모델별로 사이즈 지정 방식이 다릅니다(모두 세로형 지향):
  //  - Kling: 고정 해상도 집합만 허용(가로 기본값 1344x768). 그 세로형 짝인 768x1344를 씁니다.
  //  - Seedream: 최소 픽셀 수(약 3.68M) 제약 → 9:16인 1620x2880(4.67M).
  //  - 그 외(OG 등): 세로형 2:3(1600x2400)을 기본으로.
  let additional: Record<string, unknown>;
  if (model.modelName === 'Kling') additional = { size: opts.size || '768x1344' };
  else if (model.modelName === 'Seedream') additional = { size: opts.size || '1620x2880' };
  else additional = { size: opts.size || '1600x2400' };
  const createParams: Record<string, unknown> = {
    ModelName: model.modelName,
    ModelVersion: model.modelVersion,
    Prompt: opts.prompt,
    ImageInfos: opts.imageUrls.map((url) => ({ ImageUrl: url })),
    AdditionalParameters: JSON.stringify(additional),
  };

  // 동시 실행 제한(RequestLimitExceeded)에 걸리면 슬롯이 날 때까지 잠시 기다렸다 재시도합니다.
  const createStart = Date.now();
  let created: any;
  for (;;) {
    try {
      created = await callMps('CreateAigcImageTask', createParams);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConcurrency = /RequestLimitExceeded|maximum concurrency/i.test(msg);
      if (isConcurrency && Date.now() - createStart < TENCENT_CREATE_MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, TENCENT_CREATE_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
  const taskId: string | undefined = created?.TaskId;
  if (!taskId) throw new Error(`텐센트 태스크 생성 실패: ${JSON.stringify(created).slice(0, 300)}`);

  const start = Date.now();
  while (Date.now() - start < TENCENT_POLL_TIMEOUT_MS) {
    const status = await callMps('DescribeAigcImageTask', { TaskId: taskId });
    const s: string = status?.Status;
    if (s === 'DONE') {
      const url = status?.ImageUrls?.[0];
      if (!url) throw new Error(`텐센트 완료됐으나 결과 URL 없음: ${JSON.stringify(status).slice(0, 300)}`);
      return url;
    }
    if (s === 'FAIL') {
      throw new Error(`텐센트 생성 실패: ${status?.Message || '알 수 없는 오류'}`);
    }
    await new Promise((r) => setTimeout(r, TENCENT_POLL_INTERVAL_MS));
  }
  throw new Error(`텐센트 시간 초과: task ${taskId}`);
}
