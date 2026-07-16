// Anthropic Claude 비전 모델(claude-fable-5 / claude-opus-4-8 등)로 이미지 + 프롬프트를 보내고
// 구조화 JSON을 받습니다. Claude는 OpenAI 같은 response_format json_schema가 없으므로,
// 우리 스키마를 input_schema로 갖는 tool을 하나 정의하고 tool_choice로 그 tool 호출을 강제해
// 그 tool_use 입력(input)을 구조화 결과로 씁니다. gemini-vision의 geminiJson과 같은 역할.
import * as fs from 'fs';
import * as path from 'path';
import credentials from './credentials.local';
import { geminiToJsonSchema } from './schema-util';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 8192;

function guessMediaType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export async function anthropicVisionJson<T>(opts: {
  prompt: string;
  schema: object;
  toolName?: string;
  imagePaths?: string[];
  model: string;
}): Promise<T> {
  const key = credentials.anthropicApiKey;
  if (!key) throw new Error('.env에 ANTHROPIC_API_KEY를 채워주세요.');

  const toolName = opts.toolName || 'result';
  const content: object[] = [];
  for (const imagePath of opts.imagePaths ?? []) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: guessMediaType(imagePath),
        data: fs.readFileSync(imagePath).toString('base64'),
      },
    });
  }
  content.push({ type: 'text', text: opts.prompt });

  const body = {
    model: opts.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    tools: [{
      name: toolName,
      description: 'Return the requested structured data via this tool.',
      input_schema: geminiToJsonSchema(opts.schema),
    }],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content }],
  };

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`Claude 분석 실패 (${opts.model}, ${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  const toolUse = Array.isArray(data?.content)
    ? data.content.find((c: any) => c?.type === 'tool_use' && c?.name === toolName)
    : undefined;
  if (!toolUse?.input) {
    throw new Error(`Claude 응답에 tool_use가 없습니다 (${opts.model}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return toolUse.input as T;
}
