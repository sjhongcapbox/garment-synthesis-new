// style-room-api의 /test/gcp/proxy (DB 미사용, GCP AI Studio로 직접 프록시)를 이용한
// 이미지 업로드 / 합성 요청 / 상태 폴링 / 결과 다운로드 공용 헬퍼.
// garment-test.ts와 build-mockup.ts 둘 다 이 모듈을 사용합니다
// (서로를 직접 require하면 순환 참조가 생기므로 공용 로직은 여기로 분리했습니다).

import * as fs from 'fs';
import * as path from 'path';

export const API_BASE = 'https://api.style-room.ai';
export const PROXY_URL = `${API_BASE}/test/gcp/proxy`;
export const STATUS_URL = `${API_BASE}/test/gcp/proxy/status`;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180000;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// 프록시가 오류 상황(504/502, rate limit, 잘못된 모델명 등)에서 JSON이 아니라 HTML 에러
// 페이지를 돌려주는 경우가 있어, res.json()이 바로 터지면 "Unexpected token '<'..." 같은
// 정체불명 에러만 남습니다. 먼저 텍스트로 읽고 파싱해서, 실패 시 실제 응답 내용(앞부분)을
// 에러 메시지에 포함시켜 원인을 바로 알 수 있게 합니다.
async function parseJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`서버가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }
}

// 502/503/504처럼 게이트웨이 쪽의 일시적인 오류(순간적인 과부하, 백엔드 응답 지연 등)는
// 몇 초 후 재시도하면 성공하는 경우가 많습니다. 특히 pollStatus는 3초 간격으로 몇 분씩
// 반복 호출하는데, 그중 단 한 번이라도 이런 일시적 오류를 만나면 재시도 없이 즉시 전체
// 작업이 실패해버리는 게 실제로 관찰된 문제라 여기서 흡수합니다. 네트워크 자체가 끊긴
// 경우(fetch가 reject)도 동일하게 재시도 대상입니다.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit = {}, maxRetries = 3, retryDelayMs = 3000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        console.log(`  일시적 게이트웨이 오류(HTTP ${res.status}), ${retryDelayMs / 1000}초 후 재시도... (${attempt + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`  네트워크 오류, ${retryDelayMs / 1000}초 후 재시도... (${attempt + 1}/${maxRetries}): ${err instanceof Error ? err.message : err}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw err;
    }
  }
}

export function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`지원하지 않는 이미지 확장자: ${ext} (${filePath})`);
  }
  return mime;
}

export interface PromptConfig {
  promptTemplatePath: string;
  topDescription: string;
  bottomDescription: string;
  // v2.3 전용: prompt-23.txt의 {fittingInstructions} 자리에 넣을 핏/기장 지시사항 텍스트.
  fittingInstructions?: string;
}

export function buildPrompt({ promptTemplatePath, topDescription, bottomDescription, fittingInstructions }: PromptConfig): string {
  if (!fs.existsSync(promptTemplatePath)) {
    throw new Error(`프롬프트 템플릿을 찾을 수 없습니다: ${promptTemplatePath}`);
  }
  const template = fs.readFileSync(promptTemplatePath, 'utf-8');
  return template
    .replace(/\{topDescription\}/g, topDescription)
    .replace(/\{bottomDescription\}/g, bottomDescription)
    .replace(/\{fittingInstructions\}/g, fittingInstructions ?? '');
}

export async function uploadImage(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`이미지 파일을 찾을 수 없습니다: ${filePath}`);
  }
  const fileContent = fs.readFileSync(filePath).toString('base64');
  const fileType = guessMimeType(filePath);
  const fileName = `garment-test/${Date.now()}_${path.basename(filePath)}`;

  const res = await fetchWithRetry(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'upload_file',
      fileName,
      fileType,
      fileContent,
    }),
  });
  const data = await parseJsonResponse(res);
  if (!res.ok || !data.success) {
    throw new Error(`업로드 실패 (${filePath}): ${data.error || res.status}`);
  }
  console.log(`  업로드 완료: ${path.basename(filePath)} -> ${data.public_url}`);
  return data.public_url;
}

export interface SynthesisJob {
  job_id: string;
  status: string;
  [key: string]: unknown;
}

export interface SynthesisRequestParams {
  prompt: string;
  images: string[];
  // 생략하면 요청 본문에 aspect_ratio 필드 자체를 안 보냅니다 — 프록시/AI가 원본 이미지
  // 비율을 그대로 따라가는지 실험해보기 위해 옵션으로 뺐습니다.
  aspectRatio?: string;
  imageSize: string;
  model: string;
}

export async function requestSynthesis({
  prompt,
  images,
  aspectRatio,
  imageSize,
  model,
}: SynthesisRequestParams): Promise<SynthesisJob> {
  const body: Record<string, unknown> = {
    prompt,
    images,
    model,
    image_size: imageSize,
    batch: false,
    metadata: { clothes_type: 'garment', source: 'garment-synthesis-test' },
  };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  const res = await fetchWithRetry(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJsonResponse(res);
  if (!res.ok || !data.job_id) {
    throw new Error(`합성 요청 실패: ${JSON.stringify(data)}`);
  }
  return data;
}

export interface SynthesisStatus {
  status: string;
  result_urls?: string[];
  result_url?: string;
  error_message?: string;
  message?: string;
  [key: string]: unknown;
}

export async function pollStatus(jobId: string): Promise<SynthesisStatus> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetchWithRetry(`${STATUS_URL}/${jobId}`);
    const data = await parseJsonResponse(res);

    if (data.status === 'completed') return data;
    if (data.status === 'failed') {
      throw new Error(`합성 실패: ${data.error_message || data.message || '알 수 없는 오류'}`);
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  상태: ${data.status} (${elapsed}초 경과)`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`시간 초과 (${POLL_TIMEOUT_MS / 1000}초): job ${jobId}`);
}

export async function downloadResult(url: string, outPath: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`결과 다운로드 실패: HTTP ${res.status} (${url})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}
