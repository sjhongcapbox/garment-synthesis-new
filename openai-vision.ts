// OpenAI 비전 모델(gpt-5.6-sol / gpt-5.6-terra 등)로 이미지 + 프롬프트를 보내고 구조화 JSON을
// 받습니다. gemini-vision.ts의 geminiJson과 같은 역할이되, OpenAI Responses API를 씁니다.
// 옷 실측 분석에서 모델을 골라 쓸 수 있도록 하기 위한 대체 백엔드입니다.
import * as fs from 'fs';
import * as path from 'path';
import credentials from './credentials.local';
import { geminiToJsonSchema } from './schema-util';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// 응답 JSON에서 생성된 텍스트를 꺼냅니다. 편의 필드(output_text)를 우선 쓰되,
// 없으면 output[] 구조를 뒤져 message 타입의 첫 text를 찾습니다.
function extractText(data: any): string | undefined {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  const outputs = data?.output;
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string' && c.text) return c.text;
        }
      }
    }
  }
  return undefined;
}

export async function openaiVisionJson<T>(opts: {
  prompt: string;
  schema: object;
  schemaName?: string;
  imagePaths?: string[];
  model: string;
}): Promise<T> {
  const key = credentials.openaiApiKey;
  if (!key) throw new Error('.env에 OPENAI_API_KEY를 채워주세요.');

  const content: object[] = [{ type: 'input_text', text: opts.prompt }];
  for (const imagePath of opts.imagePaths ?? []) {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    content.push({ type: 'input_image', image_url: `data:${guessMimeType(imagePath)};base64,${b64}` });
  }

  const body = {
    model: opts.model,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: opts.schemaName || 'result',
        schema: geminiToJsonSchema(opts.schema),
        strict: true,
      },
    },
  };

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI 분석 실패 (${opts.model}, ${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  const text = extractText(data);
  if (!text) throw new Error(`OpenAI 응답에 텍스트가 없습니다 (${opts.model}): ${JSON.stringify(data).slice(0, 300)}`);
  return JSON.parse(text) as T;
}
