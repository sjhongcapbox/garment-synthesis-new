// Gemini 스키마(type: 'OBJECT'/'ARRAY'/'STRING'...)를 표준 JSON Schema(소문자 type)로 변환합니다.
// OpenAI Responses의 json_schema, Anthropic tool의 input_schema가 모두 표준 JSON Schema를 쓰므로
// 두 백엔드가 이 변환기를 공유합니다. object에는 additionalProperties:false와 전체 required를 넣어
// OpenAI strict 요건을 만족시킵니다(Anthropic도 이 형태를 그대로 허용).
export function geminiToJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(geminiToJsonSchema);
  if (node && typeof node === 'object') {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'type' && typeof v === 'string') out[k] = v.toLowerCase();
      else out[k] = geminiToJsonSchema(v);
    }
    if (typeof src.type === 'string' && src.type.toLowerCase() === 'object' && src.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(src.properties as Record<string, unknown>);
    }
    return out;
  }
  return node;
}
