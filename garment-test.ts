// 착장 합성 프롬프트/이미지 테스트 스크립트
// style-room-api의 /test/gcp/proxy (DB 미사용, GCP AI Studio로 직접 프록시)를 이용해
// front + separate 모드(상/하의 2장) + variation 없이 1장만 생성 → 로컬에 결과 저장
//
// 4번째 참조 이미지(레이아웃 목업)는 매번 실행할 때 build-mockup.ts로 자동 생성됩니다
// (모델/상의/하의 이미지를 바꾸면 목업도 그 조합에 맞게 새로 만들어짐).
//
// 사용법: 아래 CONFIG를 수정한 뒤 `npx ts-node garment-test.ts` 실행

import * as fs from 'fs';
import * as path from 'path';
import {
  buildPrompt,
  uploadImage,
  requestSynthesis,
  pollStatus,
  downloadResult,
} from './gcp-proxy';
import { buildMockup, CONFIG as MOCKUP_DEFAULTS } from './build-mockup';

const WORK_DIR = 'C:\\Users\\parra\\Downloads\\fitting';

export interface GarmentTestConfig {
  promptTemplatePath: string;
  topDescription: string;
  bottomDescription: string;
  avatarImagePath: string;
  topImagePath: string;
  bottomImagePath: string;
  // 4번째 참조 이미지(레이아웃 목업, 선택):
  // true  -> 매 실행마다 build-mockup.ts로 자동 생성 (아래 measurement 파일 기준)
  // false -> layoutMockupImagePath에 지정한 파일을 그대로 사용 (수동 제작 목업 등)
  autoGenerateMockup: boolean;
  layoutMockupImagePath: string | null;
  modelMeasurementPath: string;
  garmentMeasurementPath: string;
  aspectRatio: string;
  imageSize: string; // '1K' | '2K' | '4K'
  model: string;
}

// ===== 여기를 바꿔가며 테스트하세요 =====
export const CONFIG: GarmentTestConfig = {
  promptTemplatePath: path.join(__dirname, 'prompt-2.txt'),
  topDescription: '',
  bottomDescription: '',
  avatarImagePath: path.join(WORK_DIR, 'model1.jpg'),
  topImagePath: path.join(WORK_DIR, 't88.png'),
  bottomImagePath: path.join(WORK_DIR, 'b44.png'),
  autoGenerateMockup: true,
  layoutMockupImagePath: null,
  modelMeasurementPath: path.join(__dirname, 'measurement-model.txt'),
  garmentMeasurementPath: path.join(__dirname, 'measurement-garment.txt'),
  aspectRatio: '9:16', // GCP_AI_STUDIO_CONFIG 기준 fitting shot 기본값과 동일 계열
  imageSize: '1K', // '1K' | '2K' | '4K'
  model: 'gemini-3-pro-image-preview', // IMAGE_PRO (garment_synthesis가 쓰는 모델)
};
// ==========================================

export interface GarmentTestResult {
  jobId: string;
  resultUrls: string[];
  savedPaths: string[];
  layoutMockupImagePath: string | null;
}

export async function runGarmentSynthesisTest(config: GarmentTestConfig = CONFIG): Promise<GarmentTestResult> {
  let layoutMockupImagePath = config.layoutMockupImagePath;

  if (config.autoGenerateMockup) {
    console.log('0) 레이아웃 목업 이미지 자동 생성 중 (build-mockup.ts)...');
    layoutMockupImagePath = await buildMockup({
      ...MOCKUP_DEFAULTS,
      modelImagePath: config.avatarImagePath,
      topImagePath: config.topImagePath,
      bottomImagePath: config.bottomImagePath,
      modelMeasurementPath: config.modelMeasurementPath,
      garmentMeasurementPath: config.garmentMeasurementPath,
      outputDir: WORK_DIR,
    });
    console.log(`   목업 생성 완료: ${layoutMockupImagePath}`);
  }

  console.log('1) 이미지 업로드 중...');
  const [avatarUrl, topUrl, bottomUrl] = await Promise.all([
    uploadImage(config.avatarImagePath),
    uploadImage(config.topImagePath),
    uploadImage(config.bottomImagePath),
  ]);
  const images = [avatarUrl, topUrl, bottomUrl];
  if (layoutMockupImagePath) {
    images.push(await uploadImage(layoutMockupImagePath));
  }

  console.log('2) 합성 요청 전송 중...');
  const prompt = buildPrompt(config);
  const job = await requestSynthesis({
    prompt,
    images,
    aspectRatio: config.aspectRatio,
    imageSize: config.imageSize,
    model: config.model,
  });
  console.log(`  job_id: ${job.job_id} (status: ${job.status})`);

  console.log('3) 상태 폴링 중...');
  const result = await pollStatus(job.job_id);

  const resultUrls = result.result_urls?.length
    ? result.result_urls
    : result.result_url
    ? [result.result_url]
    : [];
  if (resultUrls.length === 0) {
    throw new Error(`완료되었지만 결과 URL이 없습니다: ${JSON.stringify(result)}`);
  }

  console.log('4) 결과 다운로드 중...');
  // 최종 합성 결과는 원본 업로드/중간 산출물과 섞이지 않도록 output/ 서브폴더에 모아 저장합니다.
  const resultsDir = path.join(WORK_DIR, 'output');
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedPaths: string[] = [];
  for (let i = 0; i < resultUrls.length; i++) {
    const outPath = path.join(resultsDir, `${timestamp}_${i + 1}.png`);
    await downloadResult(resultUrls[i], outPath);
    savedPaths.push(outPath);
    console.log(`  저장 완료: ${outPath}`);
  }

  return { jobId: job.job_id, resultUrls, savedPaths, layoutMockupImagePath };
}

if (require.main === module) {
  runGarmentSynthesisTest().catch((err) => {
    console.error('실패:', err.message);
    process.exit(1);
  });
}
