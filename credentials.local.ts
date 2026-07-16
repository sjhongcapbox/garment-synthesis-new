// 프리미엄 구독이 걸린 실계정 로그인 정보. 실제 값은 .env에만 채워 넣고 절대 대화/커밋에
// 붙여넣지 마세요 (.env는 .gitignore에 등록되어 있습니다). 필요한 키 목록은 .env.example 참고.
// email/password 대신 이미 발급받은 API 키(sr_test_... / sr_live_...)가 있으면 API_KEY만 채워도 됩니다.

import * as path from 'path';
import * as dotenv from 'dotenv';

// override: true — 부모 프로세스(예: Claude Code)에 ANTHROPIC_API_KEY 등이 이미 설정돼 있으면
// dotenv 기본 동작은 .env 값을 무시합니다. 이 로컬 도구는 .env를 authoritative로 씁니다.
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

export interface Credentials {
  email: string;
  password: string;
  apiKey: string;
  // Google AI Studio(Gemini) API 키. 이미지 이해(바운딩박스 등) 테스트용.
  geminiApiKey: string;
  // 피팅샷 대체 생성 엔진용. gpt-image-2(OpenAI 직접) / 텐센트 MPS AIGC(Qwen·Seedream·Kling).
  openaiApiKey: string;
  anthropicApiKey: string;
  tencentSecretId: string;
  tencentSecretKey: string;
}

const credentials: Credentials = {
  email: process.env.EMAIL ?? '',
  password: process.env.PASSWORD ?? '',
  apiKey: process.env.API_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  tencentSecretId: process.env.TENCENT_SECRET_ID ?? '',
  tencentSecretKey: process.env.TENCENT_SECRET_KEY ?? '',
};

export default credentials;
