# 피팅샷 v2.7 — 기능 명세 & 개발 인수인계 문서

> 대상: 이 코드를 이어받아 유지·확장할 개발자
> 기준 버전: **v2.7** (`/new27`)
> 작성 기준 파일: `editor-server.ts`, `fit-mapper.ts`, `gemini-vision.ts`, `public/new27.html`, `public/new27.js`, `prompt-27*.txt`, `prompt-fitting-27.txt`, `prompt-garment-analysis-26.txt`

---

## 0. 한눈에 보기

**피팅샷**은 "모델 전신 사진 + 옷 사진"을 넣으면 **그 모델이 그 옷을 입은 합성 이미지(피팅샷)**를 AI로 만들어 주는 로컬 테스트 도구입니다. 단일 Node.js + TypeScript HTTP 서버(`editor-server.ts`, 포트 **5177**)가 API와 정적 페이지를 모두 서빙하고, 브라우저에서 접속해 사용합니다.

한 서버 안에 v2 ~ v2.7 버전이 공존하며 경로로 구분됩니다. **v2.7은 `/new27`** 입니다.

### v2.7의 정체성 = v2.6 + 체형 재렌더

v2.7은 **v2.6을 그대로 복제**하고 딱 한 가지 큰 기능을 얹은 버전입니다.

| 계층 | v2.7이 물려받은 것 | 출처 |
|------|-------------------|------|
| 옷 분석 / 자동 종류판정 / 그룹핑 | v2.6 로직 **그대로 재사용** (라우팅이 v2.6 핸들러를 호출) | `handleV26AnalyzeGarment`, `handleV26GroupGarments`, `handleV25ClassifyItem` |
| 핏 계산 (FIT MAP) | v2.4에서 도입, v2.6의 `buildFitMapAuto` 사용 | `fit-mapper.ts` |
| 레이어링(겹쳐입기)·액세서리·신발 | v2.5에서 도입 | `runLayeredFitting` / `runLayeredSynthesize` |
| **체형 선택 + 모델 재렌더 + 헤어 변경** | **v2.7 신규** | `handleV27Reshape`, `prompt-27-reshape.txt`, `new27.js` |
| 앞/뒤/4방향 뷰 | v2.6에서 도입 | `prompt-27`, `-both`, `-four` |

즉 **v2.7에서 실제로 "새로" 추가된 코드는 체형/헤어 재렌더 파이프라인 하나**이고, 나머지 핏·합성은 프롬프트 파일만 `-27`로 바꿔 v2.5/2.6 공용 함수를 재사용합니다.

### 설계 핵심 사상 (v2.4부터 이어짐)

> **"계산은 코드가(결정론적), 문장은 LLM이."**

사진만으로는 옷의 절대 cm를 알 수 없고, LLM에 raw cm를 던져 "핏을 계산하라"고 하면 산수가 흔들려 밑단 착지 위치가 들쭉날쭉했습니다. 그래서:

1. **코드(`fit-mapper.ts`)가** 옷 실측 ↔ 모델 실측을 결정론적으로 계산해 "밑단이 무릎 아래 종아리 상단 1/3에 떨어진다" 같은 **신체 랜드마크 착지점 + 여유 등급 + 실루엣**을 확정합니다 → 이게 **FIT MAP**.
2. **LLM(핏 모델)은** 그 FIT MAP을 **문장화만** 합니다(재계산 금지).
3. **이미지 생성 모델**은 그 문장 + 옷 사진 + 모델 사진으로 최종 합성합니다.

---

## 1. 실행 & 환경

```bash
npm install                       # 최초 1회
cp .env.example .env              # 키 채우기 (아래 표)
npx ts-node editor-server.ts      # 서버 실행 (포트 5177)
```

접속: `http://localhost:5177/new27`

> `.ts`를 고치면 **서버 재시작 필요**. `.html`/`.js`/`.txt`는 저장 후 브라우저 하드 새로고침(Ctrl+F5)만 하면 반영됩니다(서버가 `Cache-Control: no-store`로 서빙).

### `.env` 키

| 키 | 용도 | v2.7 사용 여부 |
|----|------|------|
| `GEMINI_API_KEY` | Gemini 분석(모델 실측·옷 기장 추정은 항상 Gemini 고정) | ✅ 필수 |
| `EMAIL`/`PASSWORD` 또는 `API_KEY` | 이미지 생성 프록시(gcp-proxy) 로그인 | Gemini 생성 엔진 사용 시 |
| `OPENAI_API_KEY` | GPT Image-2 생성 · GPT-5.6 분석/핏 모델 | v2.7 기본 엔진이 GPT Image-2라 사실상 필수 |
| `ANTHROPIC_API_KEY` | Claude Fable/Opus 분석/핏 모델 | 선택 |
| `TENCENT_SECRET_ID/KEY/SUBAPP_ID` | 텐센트 MPS 생성 엔진 | 선택 |

### 하드코딩된 로컬 경로 (다른 환경에선 수정 필요)

`editor-server.ts` 상단 상수:
- `WORK_DIR = C:\Users\parra\Downloads\fitting` — 작업 루트
- `TMP_DIR = <WORK_DIR>/_editor_tmp` — 중간 산출물
- `OUTPUT_DIR = <WORK_DIR>/output` — 최종 합성 결과
- `DUMMY_IMAGE_PATH = <WORK_DIR>/dummy.jpg` — v2~v2.2 더미(**v2.7에선 사용 안 함**)
- `MEASUREMENTS_DIR = <프로젝트>/measurements` — 자동 분석 실측 텍스트 로그

---

## 2. 전체 아키텍처

```
브라우저 (public/new27.html + new27.js)
   │  fetch JSON (base64 dataURL 이미지)
   ▼
editor-server.ts  (http 서버, 포트 5177, 라우팅 = URL 문자열 if 체인)
   ├── gemini-vision.ts   → 옷/모델 이미지 이해 (구조화 JSON). Gemini/GPT/Claude 라우팅
   ├── fit-mapper.ts      → FIT MAP 결정론적 계산 (LLM 호출 없음, 순수 산수)
   ├── gcp-proxy.ts       → Gemini 이미지 생성 프록시
   ├── synth-providers.ts → OpenAI(gpt-image-2) · 텐센트 MPS 생성 엔진
   └── prompt-27*.txt 등  → 프롬프트 템플릿 (플레이스홀더 치환)
```

### 파일 역할

**서버 / 파이프라인**
- `editor-server.ts` — HTTP 서버, 모든 엔드포인트(v2~v2.7), 정적 서빙, 프롬프트 치환·엔진 분기
- `fit-mapper.ts` — **v2.4 핵심**: 신체 사다리 + 착지점/여유/실루엣/겹침 결정론적 계산. (파일 헤더 주석은 아직 "v2.4"로 표기되어 있음 — §9 주의사항 참고)
- `gemini-vision.ts` — 모델/옷 실측 추정, 종류 자동판정, 그룹핑, 핏 지시(Function B), 액세서리/신발 분류. Gemini/GPT/Claude 라우팅
- `gcp-proxy.ts` / `synth-providers.ts` — 생성 엔진 어댑터
- `build-mockup.ts` / `contour.ts` / `garment-test.ts` — v2~v2.2 레거시(메쉬/드레이프). **v2.7 무관**

**프론트엔드 (`public/`)**
- `new27.html` / `new27.js` — v2.7 페이지 (본 문서 대상)
- `new26.*`, `new25.*`, … — 이전 버전

**프롬프트 (`prompt-*.txt`)**
- `prompt-model-analysis.txt` — 모델 실측 추정
- `prompt-garment-analysis-26.txt` — 옷 종류 자동판정 + 실측 (v2.7이 실제로 사용)
- `prompt-fitting-27.txt` — FIT MAP → 한글 핏 문장화 (재계산 금지)
- `prompt-27.txt` / `-both` / `-four` — 최종 합성(앞 / 앞·뒤 / 4방향)
- `prompt-27-reshape.txt` — **v2.7 신규**: 체형/헤어 재렌더

---

## 3. 전체 Flow (End-to-End)

화면은 4단계 세로 워크플로우 + 1단계 내부의 체형/헤어 서브플로우로 구성됩니다.

```
[업로드]  모델 1장 + 옷 최대 5장(아무거나) + 액세서리 2 + 신발 1
   │
   ▼
① 모델 체형 분석  ──POST /api/v23/analyze-model──▶ Gemini가 키·둘레·팔다리 실측 추정
   │   └─(선택) 체형 카드 선택/치수 수정 → [모델 재렌더]
   │           ──POST /api/v27/reshape-model──▶ GPT/Gemini가 그 체형·헤어로 모델샷 재생성
   │           → 이후 단계의 "모델 입력"이 재렌더된 이미지로 교체됨
   ▼
② 옷 분석  ──POST /api/v27/analyze-garment (옷 1장당 1회)──▶ 종류 자동판정 + 실측(cm)
   │        ──POST /api/v27/classify-item──▶ 액세서리/신발 이름·착용법 분류
   │        ──POST /api/v27/group-garments──▶ 같은 옷 다른 각도 자동 묶기
   │   → 겹침(레이어) 자동 정렬, 사용자가 종류 드롭다운·드래그로 교정 가능
   ▼
③ 핏 지시사항 생성  ──POST /api/v27/fitting-instructions──▶
   │   (서버) fit-mapper.buildFitMapAuto()로 FIT MAP 계산  →  핏 모델(LLM)이 문장화
   │   → 항목별 편집 가능한 한글 지시사항
   ▼
④ 피팅샷 생성  ──POST /api/v27/synthesize (선택 엔진 1개당 1회)──▶
       모델·옷 원본 + 편집된 지시사항 + 옷 외형설명 → 이미지 생성 모델
       뷰모드(앞 / 앞·뒤 / 4방향) · 엔진 복수 선택
```

각 AI 단계는 공통 패턴을 따릅니다: **버튼 비활성화 → 타이머 시작 → `toUploadDataUrl`로 이미지 축소·base64화 → `fetch` → `parseJsonOrThrow` → 상태 갱신·재렌더 → 타이머 종료 → `refreshButtonStates()`.**

이미지는 항상 `toUploadDataUrl`로 긴 변 기준 축소(JPEG q0.92) 후 dataURL로 전송해 요청 크기를 제한합니다.

---

## 4. 단계별 상세 명세

### ① 모델 체형 분석 + 체형/헤어 재렌더 (v2.7 신규 핵심)

#### 1-A. 모델 실측 분석

- **버튼**: `#analyzeModelBtn` → `POST /api/v23/analyze-model` (v2.3 엔드포인트 재사용)
- **요청**: `{ model: dataUrl }` (전신 1장)
- **서버**: `handleV23AnalyzeModel` → `analyzeModelMeasurements(modelPath)`
  - **항상 Gemini `gemini-3.5-flash` 고정** (모델 선택 불가), `prompt-model-analysis.txt`
  - 반환 `ModelMeasurements`: `height_cm, weight_kg, shoulder_width_cm, chest_cm, waist_cm, hip_cm, arm_length_cm, torso_length_cm, leg_length_cm` (+측정선 `lines[]`)
  - `measurements/measurement-model-<난수>.txt`에도 로그 저장
- **응답 처리**: `modelSpec = data.model`. 원본 스냅샷(`originalModelFile`, `originalModelSpec`) 저장, `reshapeHistory`를 "분석 원본" 1개로 초기화, 체형/헤어 섹션(`#bodyTypeSection`) 표시.
- 실측 값은 화면에서 **직접 수정 가능**(`MODEL_FIELDS` 숫자 입력). 수정 시 `onModelMeasurementEdited()` → 체형이 '사용자 지정'으로 표시되고 재렌더 대기 상태가 됨.
- `#showModelArrowsCheck` 켜면 사진 위에 측정 위치 화살표 오버레이.

#### 1-B. 체형 선택 (BODY_PRESETS)

- **모달**: `#openBodyModalBtn` → `#bodyModal`. `BODY_PRESETS` = **남성 15 + 여성 15 = 30종** 프리셋 카드(SVG 실루엣).
- 각 프리셋은 **"키 대비 비율"**로 정의: `ratios = { shoulder, chest, waist, hip }`(키에 대한 비율) + `bmi` + `desc`(재렌더 프롬프트용 영문 체형 설명).
- **카드 선택** → `applyBodyPreset(preset)`:
  - **키·팔·상체·다리(골격)는 그대로 두고**, 어깨/가슴/허리/엉덩이 둘레와 몸무게만 프리셋으로 교체.
  - `치수 = round1(ratio × height_cm)`, `weight_kg = bmi × (h/100)²`.
  - `reshapedActive=false`, 재렌더 버튼 활성화(아직 이미지엔 반영 안 됨 — 재렌더를 눌러야 반영).
- '분석값(원본)' 카드로 되돌리기 가능(`selectOriginalBody`).
- 실루엣 SVG는 표준 대비 편차를 `SILH_AMP=1.75`배 증폭해 체형 차이가 한눈에 보이게 그림.

#### 1-C. 헤어스타일 + 색상

- **헤어 모달**: `#openHairModalBtn`. `HAIR_PRESETS` = **여성 18 + 남성 12 = 30종**. 각 `{ attrs:{len,tex,bangs,tie}, desc(영문) }`. `desc`가 재렌더 프롬프트로 전달됨. `selectedHair=null`이면 "원본 유지".
- **색상 스와치**: `HAIR_COLORS` 14종 `{ id, name, hex, en }`. `keep`(유지)이면 색 변경 없음, 그 외 `en`(영문 색 표현)이 전달됨.
- 아이콘은 `hairIconSVG`로 절차적 생성(UI 미리보기용). 백엔드엔 SVG가 아니라 텍스트(`hairDescription`/`hairColor`)만 전달.

#### 1-D. 모델 재렌더 (`#reshapeBtn` → `POST /api/v27/reshape-model`)

재렌더가 v2.7의 신규 파이프라인입니다. **"선택한 체형·헤어로 모델샷을 다시 그리되, 얼굴·키·포즈·배경은 유지"**.

- **핵심 설계**: 절대 치수(cm)만으론 이미지 모델이 사진 속 인물의 "현재 치수"를 몰라 무엇을 바꿀지 약하게 인식 → **원본 대비 "무엇을·어느 방향으로·얼마나" 바꿀지** 방향+강도 지시문을 만들어 프롬프트 최우선 지시로 실어 줌.
- **`buildBodyChangeInstruction(base, target)`** (프론트):
  - base = 현재 활성 재렌더 기록의 spec(없으면 `originalModelSpec`), target = 현재 `modelSpec`
  - 퍼센트 변화량 → 강도 버킷: `<5% slightly`, `<12% noticeably`, 그 외 `dramatically`. 임계 미만은 언급하지 않음.
  - 필드별 영문 문장 생성: 어깨(broader/narrower), 가슴·허리·엉덩이(각기 다른 형용사쌍), 몸무게(heavier·softer / leaner).
  - 예: `"Make the SHOULDERS noticeably broader than in the source photo (about 38 → 42cm)."`
- **요청 payload**:
  ```json
  {
    "model": "<dataUrl>",
    "bodyTypeDescription": "<프리셋 desc 또는 커스텀 문구>",
    "targetMeasurements": "- 키: 168cm (유지)\n- 어깨너비: 42cm\n- ...",
    "bodyChangeInstruction": "Apply each of these changes clearly and visibly:\n- ...",
    "hairDescription": "<선택 시 헤어 desc>",
    "hairColor": "<선택 시 영문 색 / keep면 빈 문자열>",
    "engine": "gpt-image-2-high | gpt-image-2-medium | gemini"
  }
  ```
- **서버 `handleV27Reshape`**:
  - `prompt-27-reshape.txt` 로드 후 `{bodyTypeDescription}`, `{targetMeasurements}`, `{bodyChangeInstruction}`, `{hairInstruction}` 치환.
  - `hairInstruction`은 서버에서 생성: 헤어/색 중 하나라도 지정되면 "얼굴 100% 유지 + 헤어만 변경" 문장, 없으면 "원본 헤어 그대로" 문장.
  - 엔진 분기: `gpt-image-2*`(기본 `high`, **2K 고정 1536×2752**) / 텐센트 / Gemini(gcp-proxy).
  - 결과를 `OUTPUT_DIR/v27_reshape_<engine>_<ts>.png`로 저장, `{ resultDataUrl, savedPath, engine }` 반환.
- **응답 처리(프론트)**:
  - `dataUrlToFile`로 변환해 **`files.model[0]`을 재렌더 이미지로 교체** → 이후 모든 단계가 새 모델을 사용.
  - `reshapeHistory`에 `{ name, dataUrl, spec, presetId, active:true }` 추가(원본 + 매 재렌더 누적, 썸네일 스트립). 기록에서 이전 모델로 되돌리기 가능(`useHistoryModel`).
  - 헤어 선택은 이미 이미지에 반영됐으므로 '유지'로 리셋(`resetHairSelection`).
  - **다운스트림 무효화**: `fittingItems=[]; lastFitMap=null` (새 몸엔 새 핏이 필요).
- **재렌더 엔진 라디오**: `name="reshapeEngine"` — `gpt-image-2-high`(기본, 2K) / `gpt-image-2-medium` / `gemini`.

---

### ② 옷 분석 (자동 종류판정 · 그룹핑 · 레이어)

v2.7의 옷 슬롯은 **종류 구분이 없습니다**. 상의·하의·원피스·세트를 아무거나 한 슬롯(`garment`, 최대 5장)에 올리면 AI가 종류를 스스로 판정합니다.

- **버튼**: `#analyzeBtn`. `Promise.allSettled`로 사진 1장당 1요청 병렬.
- **분석 모델 선택** (`name="analysisModel"`): `gemini-3.5-flash` / `gpt-5.6-sol` / **`gpt-5.6-terra`(기본)** / `claude-fable-5` / `claude-opus-4-8`. 모델명 접두사로 백엔드 라우팅(`gpt*`→OpenAI, `claude*`→Anthropic, 그 외→Gemini).

#### 2-A. 옷 종류 자동판정 + 실측

- `analyzeGarmentAt` → `POST /api/v27/analyze-garment`, 요청 `{ garment: dataUrl, analysisModel, forcedCategory? }`
- 서버 `handleV27AnalyzeGarment` → `handleV26AnalyzeGarment(req, res, GARMENT_ANALYSIS_27_PATH)` → `analyzeGarmentAuto(imagePath, model, forced, promptPath)`
  - 프롬프트 **`prompt-garment-analysis-27.txt`** 사용 (v2.6과 격리 — `analyzeGarmentAuto`의 `promptPath` 인자로 주입, 기본값은 `-26`)
  - STEP1 종류판정 `top|bottom|dress|set` → STEP2 그 종류로 실측(cm, 작업지시서식) + 측정선 좌표 → STEP3 한글 외형 설명
  - 반환 `GarmentSpec & { category }`. 저장 형태: `specs.garment[i] = { spec, img, include:true, category }` (index = 업로드/겹 순서)
- 오판정 시 각 카드의 **[종류] 드롭다운**으로 강제 재분석(`forcedCategory`) 가능.

#### 2-B. 액세서리 / 신발 분류

- `analyzeWornAt` → `POST /api/v27/classify-item`, 요청 `{ image, kind:'accessory'|'shoes', analysisModel }`
- 서버 `handleV25ClassifyItem`(재사용) → `classifyWornItem` → `WornItem { name, description, worn_on, wear_style, measurements[] }`
- 옷과 같은 형태로 저장하되 `include:false`(기본 미포함). 가방 등은 `wear_style`(어깨/크로스/팔/손/백팩)이 그림을 크게 바꾸므로 사용자가 선택 가능.

#### 2-C. 자동 그룹핑 (같은 옷, 다른 각도)

- 첫 일괄 분석 직전 `autoGroupGarments` → `POST /api/v27/group-garments`
- 서버 `handleV26GroupGarments` → `groupGarments(paths, model)` (프롬프트 `prompt-garment-grouping.txt`)
- 반환 `GarmentGroup[] { representative_index, view_indices, category, reason }`: "같은 실물 옷의 다른 각도"를 **대표 1장 + 뷰(뒤·옆)**로 묶음. 측정·종류판정은 대표만, 뷰는 합성 때 외형 참고용.
- 유효성 검사(모든 index가 정확히 한 번씩 등장)에 실패하면 안전하게 원본 유지.
- 사용자 교정: 카드 **[합치기]/[분리]**, 썸네일 **드래그앤드롭**(옷↔옷 합치기, 뷰→별도 옷 분리), `+뷰`로 각도 추가(최대 `MAX_VIEWS=3`).

#### 2-D. 겹침(레이어) 순서

- 같은 종류가 여러 장이면 "이너 → 중간 → 겉" 겹 순서가 생김. 카드 제목은 `상의 L2 (겉)` 형태.
- **자동 1차 정렬** `autoOrderLayers`: 옷종류 키워드 + 둘레 실측으로 `layerRank` 계산(코트/패딩=90, 자켓=70, 셔츠=45, 니트/티=30…), 같은 종류 내에서 안→밖 정렬. 사용자가 손대면(`manualLayerOverride`) 자동 정렬 중지.
- **수동 재정렬**: 상단 레이어 칩 바(`#layerBar`) 드래그, 또는 카드 화살표(`moveGarmentLayer`).
- 겹 순서/구성이 바뀌면 이전 핏 지시사항은 무효화(`fittingItems=[]; lastFitMap=null`).

---

### ③ 핏 / 기장 지시사항 생성

- **버튼**: `#instructionsBtn` → `POST /api/v27/fitting-instructions`
- **핏 모델 선택** (`name="fittingModel"`): 옷 분석 모델과 별개. 기본 `gpt-5.6-terra`.
- **요청 payload**(프론트가 `bucketGarments()`로 카테고리별 분류; **set은 dress 버킷으로**):
  ```json
  {
    "modelSpec": { ...ModelMeasurements },
    "fittingModel": "gpt-5.6-terra",
    "topSpecs": [...], "bottomSpecs": [...], "dressSpecs": [...],
    "topImages": [...], "bottomImages": [...], "dressImages": [...],
    "accessorySpecs": [{ name, worn_on, wear_style, measurements }],
    "shoesSpecs": [...]
  }
  ```

#### 서버 처리 — `handleV27FittingInstructions` → `runLayeredFitting(..., PROMPT_FITTING_27_PATH, buildFitMapAuto, 'v27')`

1. `modelSpec` 없으면 에러("먼저 모델 체형 분석 실행").
2. **`buildFitMapAuto(modelSpec, { tops, bottoms, dresses, accessories, shoes })`** — 순수 코드 계산(LLM 없음)으로 FIT MAP 생성. (§6 참고)
3. **`deriveFittingInstructions`** — 핏 모델(LLM)에게 `prompt-fitting-27.txt` + FIT MAP 텍스트 + 옷 이미지(정성 맥락)를 주고 **한글 문장화만** 시킴.
   - `layerLabels`(FIT MAP에 실제 존재하는 겹 라벨)를 enum으로 강제해 "이 문장이 어느 겹 이야기인지" 고정.
4. 반환 `{ items, fitMap:{ ladder, garments, text } }`.

#### 응답 처리 (프론트)

- `lastFitMap = data.fitMap` — **화면엔 렌더 안 하고** `window.lastFitMap` 디버그 전역으로만 노출(`renderFitMap()`은 wrap을 비움).
- `fittingItems = data.items` — 각 `{ garment:'top'|'bottom'|'dress'|'overall', layer?, category, instruction }`.
- `renderFittingItems()`:
  - `INSTRUCTION_GROUPS`(top/bottom/dress/overall) → `layer`별로 그룹핑.
  - `overall`은 `category` 정규식으로 **액세서리 / 신발 / 레이어링** 하위그룹 재분할.
  - 각 항목 = 카테고리 칩 + **편집 가능한 textarea**(수정분이 최종 합성에 반영됨).
- **`#noInstrCheck`("핏 지시사항 없이 생성")**: 켜면 지시사항을 비워 순수 비교(핏 지시 영향 배제).

---

### ④ 피팅샷 생성 (최종 합성)

- **버튼**: `#synthBtn`. 게이트: 필수 이미지 있음 AND (지시사항 있음 OR noInstr 체크) AND 엔진 ≥1개.
- **생성 엔진 복수 선택**(`#engineChecks`, `ENGINES`): `gemini`, `gpt-image-2-high-2k`, `-high-1k`, `-medium-2k`(**기본**), `-medium-1k`. **선택 엔진 1개당 1요청** 병렬 → 결과를 나란히 비교.
- **뷰 모드**(`name="viewMode"`):
  - `front`(기본) — 앞면 1장(세로 9:16 계열)
  - `both` — 앞·뒤 한 이미지(1:1 정사각)
  - `four` — 앞·완전좌측·뒤·완전우측 한 줄(16:9 가로)
- **요청 payload**(`runSynthShot`가 엔진별로 `{ ...base, engine }`):
  ```json
  {
    "model": "<dataUrl>",
    "topImages": [...], "bottomImages": [...], "dressImages": [...],
    "extraViewImages": [...], "extraViewLabels": [...],
    "accessoryImages": [...], "accessoryNames": [...], "accessoryStyles": [...],
    "shoesImages": [...], "shoesNames": [...],
    "items": [{ garment, layer, category, instruction }],   // 비어있지 않은 instruction만
    "garmentDescriptions": ["<title>: <type>\n  · 디자인: ...\n  · 소재 및 색상: ..."],
    "noInstructions": true,   // noInstr 체크 시에만
    "viewMode": "front|both|four",
    "engine": "gpt-image-2-medium-2k"
  }
  ```
  - `garmentDescriptions`는 **[포함하기]가 켜진(`include:true`) 항목만** 포함(`DESC_FIELDS`: 디자인 / 소재 및 색상 / 디테일).

#### 서버 처리 — `handleV27Synthesize` → `runLayeredSynthesize(..., PROMPT_27_PATH, PROMPT_27_BOTH_PATH, PROMPT_27_FOUR_PATH)`

1. **이미지 매니페스트 동적 생성**(`buildV25Manifest`): 업로드된 것만 `[IMAGE n]: <역할설명>`으로 나열. 없는 슬롯은 아예 등장하지 않음("없는 건 발명하지 말라" 규칙과 자연스럽게 맞물림).
   - `[IMAGE 1]` = Source Model(얼굴·헤어·체형·포즈 고정, 배경 제거, 기존 옷은 교체 대상)
   - 이어서 옷(레이어 번호 주석 포함), 원피스/세트, 액세서리(착용법), 신발, 추가뷰 순.
   - **신발 미업로드 시**: "소스 모델의 신발을 버리고 코디에 맞춰 새로 생성" 지시를 매니페스트에 추가.
2. 뷰모드에 따라 프롬프트 파일·종횡비 선택(`front→prompt-27` / `both→prompt-27-both`(1:1) / `four→prompt-27-four`(16:9)).
3. 템플릿에 `{imageManifest}`, `{garmentDescriptions}`, `{fittingInstructions}` 치환. (`noInstructions`면 지시사항 자리에 `{}`)
4. 엔진 분기:
   - **`gpt-image-2*`**: 로컬 파일 multipart 업로드. quality(medium/high)·size는 엔진키 접미사와 뷰모드로 결정
     (예: front+2k = 1536×2752, both+2k = 2752×2752, four+2k = 2752×1536).
   - **텐센트**: 긴 변 1280px JPEG로 축소 후 URL 업로드.
   - **Gemini(gcp-proxy)**: URL 업로드 → `requestSynthesis` → `pollStatus` → 다운로드.
5. 결과를 `OUTPUT_DIR/v25_fitting_<engine>_<ts>_<n>.png`로 저장, `{ savedPaths, resultDataUrls, engine, imageCount }` 반환.
   (파일 접두사가 `v25_`인 것은 공용 핸들러를 재사용하기 때문 — 의도된 것)

#### 응답 처리 (프론트)

`runSynthShot`가 엔진별 pending 타일 → 결과 이미지 렌더. `imageCount`(참조 이미지 수)·엔진 라벨 표시. `#clearResultsBtn`로 결과 초기화. 이미지 클릭 시 라이트박스(`#modalOverlay`) 확대.

---

## 5. API 엔드포인트 요약 (v2.7 관련)

| Method · URL | 핸들러 | 역할 |
|---|---|---|
| `POST /api/v23/analyze-model` | `handleV23AnalyzeModel` | 모델 실측 추정(Gemini 고정) |
| `POST /api/v27/analyze-garment` | `handleV27AnalyzeGarment` → `handleV26AnalyzeGarment`(prompt `-27` 주입) | 옷 종류 자동판정 + 실측 |
| `POST /api/v27/classify-item` | `handleV25ClassifyItem`(재사용) | 액세서리/신발 분류 |
| `POST /api/v27/group-garments` | `handleV26GroupGarments`(재사용) | 같은 옷 다른 각도 그룹핑 |
| `POST /api/v27/reshape-model` | `handleV27Reshape` | **체형/헤어 재렌더 (v2.7 신규)** |
| `POST /api/v27/fitting-instructions` | `handleV27FittingInstructions` → `runLayeredFitting` | FIT MAP 계산 + 핏 문장화 |
| `POST /api/v27/synthesize` | `handleV27Synthesize` → `runLayeredSynthesize` | 최종 합성 |
| `GET /new27` | `serveStatic` | `public/new27.html` 서빙 |

> 라우팅은 `editor-server.ts` 하단 `http.createServer` 안의 URL 문자열 `if` 체인. v2.7은 분석/그룹핑/분류를 v2.6·v2.5 핸들러로 재사용하고, **핏/합성은 `-27` 프롬프트로**, **재렌더만 신규 핸들러**로 처리합니다.

---

## 6. 핵심 모듈 명세

### 6-A. `fit-mapper.ts` — FIT MAP 결정론적 계산

LLM 없이 순수 산수로 "옷 cm ↔ 모델 몸"을 계산합니다. 모든 높이는 **바닥=0, 머리끝=height_cm 기준 cm**.

**Export 함수 3종** (v2.7은 `buildFitMapAuto`만 사용):
```ts
buildFitMap(model, { top?, bottom?, dress? }): FitMap          // v2.4: 슬롯당 1벌, 레이어링 없음
buildFitMapLayered(model, LayeredGarments): FitMap             // v2.5: 슬롯당 여러 겹 + 겹침 계산
buildFitMapAuto(model, LayeredGarments): FitMap                // v2.6/2.7: 원피스+상하의 공존, 상·하체 스택별 가림 계산
```

**핵심 로직**:
- **`buildLadder(model)`**: 모델 실측으로 신체 세로 사다리 생성. 측정 앵커 2개(허리=다리길이 `L`, 어깨=`L+T`)를 쓰고 미측정 지점(발목·무릎·사타구니·골반)은 다리길이 비율로 보간
  (`ankle 0.065L, knee 0.47L, crotch 0.79L, hip 0.88L`; 인체비례 상수 기반).
- **`analyzeGarment(slot, spec, m, lad)`** — 옷 1벌당 착지점 계산:
  - **총장** → 하의는 `hemH = 허리 - 총장`(자연허리 착용 가정), 상의/원피스는 `hemH = 어깨 - 총장`. `hemH`를 FitRow에 저장해 이후 겹침 계산이 문자열 재파싱 없이 씀.
  - **소매** → `소매길이/팔길이` 비율을 팔 랜드마크로 매핑(민소매~손등 덮음까지 10단계).
  - **어깨너비** → 모델 어깨와 비교(슬림/정핏/드롭숄더).
  - **여유(ease)** → 단면(반폭)을 ×2해 몸 둘레와 비교 → 등급화(`밀착 / 타이트 / 정핏 / 세미루즈 / 루즈 / 오버사이즈`, 컷 `-3/2/7/14/22`) + 반경 여유(`ease/2π`).
  - **실루엣** → 단면 사다리로 A라인/테이퍼/스트레이트 등 분류.
- **겹침/가림(v2.5+)**: `occludeOrderedList`가 안→밖 순으로 "겉옷에 가려 안 보이는 이너 소매/밑단"을 "그리지 말라"로 재작성. `buildFitMapAuto`는 **상체 스택**(원피스+상의)과 **하체 스택**(원피스+하의)을 따로 두고 상체 스택에만 소매/상체 가림 계산 적용.
- **액세서리/신발**(`analyzeWornItem`): 핏이 아니라 "크기·걸리는 위치". `wear_style`에 따라 걸림 높이 계산(손/팔꿈치/스트랩드롭/백팩), 부츠 목높이·굽높이·가방 크기(어깨너비 대비 비율).
- **출력** `FitMap { ladder, garments, text }`. `text`가 핏 프롬프트에 들어가는 사전계산 FIT MAP(재계산 금지 헤더 + 랜드마크 + 겹침·가림 블록 포함).

**주요 타입**:
```ts
interface FitModel { height_cm; weight_kg?; shoulder_width_cm; chest_cm; waist_cm;
                     hip_cm; arm_length_cm; torso_length_cm; leg_length_cm }
interface FitRow { label; value_cm; kind:'hem'|'sleeve'|'ease'|'shoulder'|'note'|'silhouette';
                   result; hemH? }
interface FitGarmentResult { slot:'top'|'bottom'|'dress'|'accessory'|'shoes'; type; rows; layerLabel? }
interface FitMap { ladder:{name,h}[]; garments:FitGarmentResult[]; text }
interface LayeredGarments { tops?; bottoms?; dresses?; accessories?; shoes? }
```

### 6-B. `gemini-vision.ts` — AI 이미지 이해

이미지 → 구조화 JSON(모든 호출 `temperature:0` + `responseSchema` 강제). **모델 접두사 라우팅**: `gpt*`→OpenAI, `claude*`→Anthropic, 그 외→Gemini(기본 `gemini-3.5-flash`).

| 함수 | 모델 | 프롬프트 | 반환 |
|---|---|---|---|
| `analyzeModelMeasurements(img)` | **Gemini 고정** `3.5-flash` | `prompt-model-analysis.txt` | `ModelMeasurements` |
| `analyzeGarmentAuto(img, model?, forced?, promptPath?)` | 라우팅 | `promptPath`(v2.7=`prompt-garment-analysis-27.txt`, 기본=`-26`) | `GarmentSpec & { category }` |
| `analyzeGarmentSpec(img, cat, model?)` | 라우팅 | `prompt-garment-analysis.txt` | `GarmentSpec` |
| `groupGarments(paths, model?)` | 라우팅 | `prompt-garment-grouping.txt` | `GarmentGroup[]` |
| `classifyWornItem(img, kind, model?)` | 라우팅 | 인라인 | `WornItem` |
| `deriveFittingInstructions(opts)` | 라우팅(`opts.model`) | `opts.promptPath`(v2.7=`prompt-fitting-27.txt`) | `FittingInstructionItem[]` |
| `estimateGarmentLength(img, slot, hCm)` | **Gemini 고정** `2.5-flash` | 인라인 | `{ garment_type, total_length_cm }` |
| `formatGarmentSpecText / formatModelMeasurementsText / formatFittingInstructionsText` | (AI 아님, 순수 포맷터) | — | 텍스트 |

**주요 타입**:
```ts
type GarmentCategory = 'top'|'bottom'|'dress'|'set'
interface GarmentSpec { garment_type; description; design?; material_color?; details?;
                        measurements: { label; value_cm; x1?;y1?;x2?;y2? }[] }  // 핏/기장 칸 없음(FIT MAP이 유일 출처)
interface WornItem { name; description; design?; material_color?; details?;
                     worn_on; wear_style; measurements[] }
interface GarmentGroup { representative_index; view_indices[]; category; reason }
interface FittingInstructionItem { garment:'top'|'bottom'|'dress'|'overall'; layer?; category; instruction }
interface ModelMeasurements { height_cm; weight_kg; shoulder_width_cm; chest_cm; waist_cm;
                              hip_cm; arm_length_cm; torso_length_cm; leg_length_cm; lines? }
```

> 측정 좌표(`x1,y1,x2,y2`)는 정규화 **0–1000**(0=이미지 상단). 사진 위 측정선 오버레이에 사용.

---

## 7. 프롬프트 파일 명세 (v2.7)

| 파일 | 역할 | 플레이스홀더 |
|---|---|---|
| `prompt-model-analysis.txt` | 모델 전신 → 신체 실측 추정 | (없음) |
| `prompt-garment-analysis-27.txt` | 옷 1장 → 종류판정(`{forcedCategory}` 강제 훅) + 실측 + 외형설명. **디자인/소재/디테일에 핏·기장 언급 금지**. (v2.6과 격리된 v2.7 전용 파일 — `analyzeGarmentAuto`의 `promptPath`로 주입) | `{forcedCategory}` |
| `prompt-garment-grouping.txt` | 여러 옷 사진 → 같은 실물끼리 그룹핑 | `{count}` |
| `prompt-fitting-27.txt` | FIT MAP → 한글 핏 문장. **재계산 금지**, 사진은 텍스처/드레이프만. 레이어/가림은 "최종 상태" 서술. 출력=태그드 항목(layer/garment/category/instruction) | `{modelMeasurements}`, `{garmentMeasurements}` |
| `prompt-27.txt` | 앞면 1장 합성(#333333 차콜 배경). 규칙 위계: ①모델·포즈 불변 ②레이어링(가려진 건 가린 채) ③외형은 사진·핏은 스펙 ④액세서리·신발 ⑤리얼리즘 ⑥배경 ⑦고품질 | `{imageManifest}`, `{garmentDescriptions}`, `{fittingInstructions}` |
| `prompt-27-both.txt` | 같은 모델 앞(좌)·뒤(우) 한 이미지(1:1). 모든 규칙을 두 인물에 적용 | 동일 3종 |
| `prompt-27-four.txt` | 같은 모델 앞·완전좌·뒤·완전우 4인물 한 줄(16:9) | 동일 3종 |
| `prompt-27-reshape.txt` | **v2.7 신규**: 모델 1장 → 체형/헤어 리터치. ①정체성·**키** 불변 ②포즈·프레이밍 유지 ③`bodyChangeInstruction`이 최우선(치수는 보조 크로스체크) ④리얼리즘 | `{bodyTypeDescription}`, `{targetMeasurements}`, `{bodyChangeInstruction}`, `{hairInstruction}` |

**플레이스홀더 데이터 흐름**:
```
UI 종류 드롭다운 → {forcedCategory} → prompt-garment-analysis-27 → GarmentSpec
GarmentSpec + ModelMeasurements → fit-mapper → FIT MAP text → {garmentMeasurements}
ModelMeasurements → {modelMeasurements} ┐→ prompt-fitting-27 → 핏 문장 → {fittingInstructions}
매니페스트 빌더 → {imageManifest}, include된 외형설명 → {garmentDescriptions} ┘→ prompt-27(/both/four) → 최종 이미지
체형·헤어 UI → {bodyTypeDescription}/{targetMeasurements}/{bodyChangeInstruction}/{hairInstruction} → prompt-27-reshape → 재렌더 모델
```

---

## 8. 주요 UI 요소 ID (new27.html)

- **업로드**: `#uploadArea`, `#imageCountHint`, `#status`
- **① 모델**: `#analyzeModelBtn`, `#modelElapsed`, `#showModelArrowsCheck`, `#modelSpecBox`
  - 체형/헤어: `#bodyTypeSection`, `#openBodyModalBtn`/`#selectedBodyLabel`/`#bodyModal`/`#bodyModalGrid`, `#openHairModalBtn`/`#hairLabel`/`#hairModal`/`#hairColorRow`, `#reshapeBtn`/`#reshapeElapsed`/`#reshapeHint`, `#reshapeResult`(기록 스트립), `name="reshapeEngine"`
- **② 옷**: `#analyzeBtn`, `#garmentElapsed`, `#showArrowsCheck`, `name="analysisModel"`, `#garmentSection`/`#specGrid`, `#layerBar`, `#accSection`/`#accGrid`, `#shoesSection`/`#shoesGrid`
- **③ 핏**: `name="fittingModel"`, `#instructionsBtn`, `#instrElapsed`, `#noInstrCheck`, `#fitMapWrap`, `#instructionsWrap`
- **④ 합성**: `#engineChecks`/`#engineAllBtn`, `name="viewMode"`, `#synthBtn`, `#clearResultsBtn`, `#resultWrap`
- **모달**: `#modalOverlay`/`#modalImg`

---

## 9. 알려진 한계 · 주의사항 (인수인계 체크리스트)

1. **v2.7 옷 분석 프롬프트는 `-27`로 격리됨**: `analyzeGarmentAuto(imagePath, model, forced, promptPath)`의 `promptPath`(기본 `-26`)로 버전별 프롬프트를 주입합니다. `/api/v27/analyze-garment` → `handleV27AnalyzeGarment` → `handleV26AnalyzeGarment(req, res, GARMENT_ANALYSIS_27_PATH)` 경로로 **`prompt-garment-analysis-27.txt`**를 로드. v2.7만 따로 튜닝할 때 이 파일을 수정하면 v2.6엔 영향 없음.
2. **`fit-mapper.ts` 헤더 주석이 "v2.4"**: 파일 상단이 아직 v2.4로 표기됨(기능은 v2.5/2.6 확장 포함). 코드 소유자와 버전 표기 정리 필요.
3. **핸들러/파일 접두사가 `v25_`/`v26_`**: v2.7이 공용 핸들러(`runLayeredFitting`/`runLayeredSynthesize`)와 v2.6 분석 핸들러를 재사용하기 때문. 출력 파일명이 `v25_fitting_*`, tmp 접두사가 `v26_garment`인 것은 정상(의도된 재사용).
4. **HTML의 스텝4 힌트가 `prompt-25.txt` 언급**: 오래된 문구. 실제 합성 프롬프트는 `prompt-27*.txt`.
5. **모델 실측·옷 기장 추정은 Gemini 고정**: `analyzeModelMeasurements`(3.5-flash), `estimateGarmentLength`(2.5-flash)는 모델 선택을 무시하고 항상 Gemini. `GEMINI_API_KEY` 없으면 이 두 경로가 실패.
6. **하의 밑단은 "자연 허리 착용" 가정**으로 계산(하이/로우라이즈 보정 미구현). 밑위 값은 참고 표시만.
7. **미측정 랜드마크(무릎·발목 등)는 인체비례 보간** → ±2~3cm 오차(구간 표현으로 흡수).
8. **Claude(Fable/Opus) 모델은 계정 크레딧 필요**.
9. **재렌더는 원본 대비 방향+강도 지시가 결정적**: `buildBodyChangeInstruction`이 base(활성 기록 spec)와 target(현재 modelSpec) 차이를 계산하므로, 재렌더 후 다시 재렌더하면 "이전 재렌더 결과 대비" 변화가 계산됨. 원본 대비로 바꾸려면 기록에서 원본으로 되돌린 뒤 진행.
10. **모델/옷/겹 구성이 바뀌면 핏 지시사항은 항상 무효화**(`fittingItems=[]; lastFitMap=null`) — ③을 다시 눌러야 함.

---

*이 문서는 v2.7 시점 코드를 기준으로 작성되었습니다. 로컬 경로(`WORK_DIR` 등)와 API 키는 `editor-server.ts` 상단·`.env`에서 환경에 맞게 조정하세요.*
