// 알파 마스크(옷 윤곽선 PNG 등)에서 바깥쪽 테두리를 추적하고, 그 폐곡선을 둘레 길이 기준
// 등간격 n개 점으로 다시 뽑는 유틸리티. 메쉬 와프 에디터의 컨트롤 포인트(옷 실루엣 둘레를
// 따라 동간격으로 찍는 점들)를 만드는 데 씁니다.
//
// (참고) 처음엔 픽셀 단위 Moore-neighbor tracing을 구현했는데, 얇은 대각선 모서리(칼라 끝
// 뾰족한 점 등)에서 추적이 제자리를 맴돌며 수백만 스텝을 도는 버그가 있었습니다. 대신 이
// 프로젝트에서 이미 신뢰성이 검증된 "행(row)별 좌/우 끝 스캔" 방식을 위/아래로 확장해
// 폐곡선을 만듭니다 — 오목한 부분(겨드랑이 등)의 아주 미세한 굴곡은 단순화되지만, 무한루프
// 위험 없이 안정적으로 바깥 윤곽을 따라갑니다.

export interface Point {
  x: number;
  y: number;
}

// 오른쪽 가장자리(위→아래, 각 행의 가장 오른쪽 전경 픽셀) + 왼쪽 가장자리(아래→위, 각 행의
// 가장 왼쪽 전경 픽셀)를 이어붙여 폐곡선을 만듭니다.
export function traceContour(isFg: (x: number, y: number) => boolean, width: number, height: number): Point[] {
  const rightEdge: Point[] = [];
  const leftEdge: Point[] = [];
  for (let y = 0; y < height; y++) {
    let minX = -1, maxX = -1;
    for (let x = 0; x < width; x++) {
      if (isFg(x, y)) { if (minX === -1) minX = x; maxX = x; }
    }
    if (maxX >= 0) {
      rightEdge.push({ x: maxX, y });
      leftEdge.push({ x: minX, y });
    }
  }
  leftEdge.reverse();
  return [...rightEdge, ...leftEdge];
}

function polygonPerimeter(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

// 폐곡선(폴리곤)을 둘레 길이 기준 n개의 등간격 점으로 리샘플합니다.
export function resampleClosedContourByCount(points: Point[], n: number): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: n }, () => points[0]);
  const perimeter = polygonPerimeter(points) || 1;
  const step = perimeter / n;
  const out: Point[] = [];
  let segIdx = 0;
  let segStart = points[0];
  let segEnd = points[1 % points.length];
  let segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) || 1e-6;
  let traveled = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (traveled + segLen < target && segIdx < points.length) {
      traveled += segLen;
      segIdx++;
      segStart = points[segIdx % points.length];
      segEnd = points[(segIdx + 1) % points.length];
      segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) || 1e-6;
    }
    const distIntoSeg = target - traveled;
    const t = Math.max(0, Math.min(1, distIntoSeg / segLen));
    out.push({ x: segStart.x + (segEnd.x - segStart.x) * t, y: segStart.y + (segEnd.y - segStart.y) * t });
  }
  return out;
}

// 배경 제거가 완벽하지 않으면 옷과 동떨어진 자리에 작은 노이즈 얼룩(고립된 불투명 픽셀
// 몇 개)이 남을 수 있습니다. traceContour는 행(row)별 "가장 왼쪽/오른쪽 전경 픽셀"만
// 보기 때문에, 그런 노이즈 하나가 옷 실루엣보다 훨씬 왼쪽/오른쪽에 있으면 그 행의 경계로
// 잘못 뽑혀 컨트롤 포인트가 옷 밖으로 튀어버립니다. 가장 큰 연결 성분(실제 옷)만 전경으로
// 남기고 나머지 고립 노이즈는 무시해서 이 문제를 막습니다.
function largestComponentMask(
  data: Buffer | Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number,
): Uint8Array {
  const isFgRaw = (x: number, y: number): boolean => data[(y * width + x) * 4 + 3] > alphaThreshold;
  const labels = new Int32Array(width * height).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (labels[start] !== -1 || !isFgRaw(x, y)) continue;
      labels[start] = start;
      stack.length = 0;
      stack.push(start);
      let size = 0;
      while (stack.length > 0) {
        const pos = stack.pop() as number;
        size++;
        const px = pos % width;
        const py = (pos - px) / width;
        const neighbors: Array<[number, number]> = [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const npos = ny * width + nx;
          if (labels[npos] !== -1 || !isFgRaw(nx, ny)) continue;
          labels[npos] = start;
          stack.push(npos);
        }
      }
      if (size > bestSize) { bestSize = size; bestLabel = start; }
    }
  }
  const mask = new Uint8Array(width * height);
  if (bestLabel !== -1) {
    for (let i = 0; i < width * height; i++) {
      if (labels[i] === bestLabel) mask[i] = 1;
    }
  }
  return mask;
}

// 알파 채널 raw 버퍼에서 바로 등간격 둘레 점을 뽑는 편의 함수.
export function contourPointsFromAlpha(
  data: Buffer | Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number,
  pointCount: number,
): Point[] {
  const mask = largestComponentMask(data, width, height, alphaThreshold);
  const isFg = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return mask[y * width + x] === 1;
  };
  const raw = traceContour(isFg, width, height);
  return resampleClosedContourByCount(raw, pointCount);
}
