// style-room-api의 실제 배경 제거 파이프라인(POST /image-edit, operation: bg_remove)을 사용합니다.
// JwtOrApiKeyGuard라 프리미엄 구독 계정의 JWT 또는 API 키가 필요합니다 (credentials.local.ts 참조).
// 입력 이미지는 반드시 공개 URL(GCS 등)이어야 하며, 결과도 폴링을 통해 URL로 받습니다.

import credentials from './credentials.local';

const API_BASE = 'https://api.style-room.ai';

let cachedToken: string | null = null;

export async function getAuthToken(): Promise<string> {
  if (credentials.apiKey) return credentials.apiKey;
  if (cachedToken) return cachedToken;
  if (!credentials.email || !credentials.password) {
    throw new Error('credentials.local.ts에 email/password 또는 apiKey를 채워주세요.');
  }
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  const data = await res.json();
  if (!res.ok || !data.accessToken) {
    throw new Error(`로그인 실패: ${JSON.stringify(data)}`);
  }
  cachedToken = data.accessToken;
  return cachedToken as string;
}

export interface RemoveBackgroundOptions {
  format?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function removeBackground(
  imageUrl: string,
  { format = 'png', pollIntervalMs = 3000, timeoutMs = 240000 }: RemoveBackgroundOptions = {},
): Promise<string> {
  const token = await getAuthToken();

  const createRes = await fetch(`${API_BASE}/image-edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ inputUrls: [imageUrl], operation: 'bg_remove', format }),
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.jobs?.length) {
    throw new Error(`bg_remove 요청 실패: ${JSON.stringify(createData)}`);
  }
  const job = createData.jobs[0];
  if (job.status === 'failed') {
    throw new Error(`bg_remove 즉시 실패: ${job.error}`);
  }
  const jobCode = job.jobCode;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statusRes = await fetch(`${API_BASE}/image-edit/jobs/${jobCode}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const statusData = await statusRes.json();
    if (statusData.status === 'completed') return statusData.outputUrl;
    if (statusData.status === 'failed') {
      throw new Error(`bg_remove 실패: ${statusData.errorMessage || '알 수 없는 오류'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`bg_remove 시간 초과: ${jobCode}`);
}
