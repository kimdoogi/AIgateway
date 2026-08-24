import { readFileSync } from "node:fs";

// 콘솔 정적 페이지 로더 — HTML은 이 모듈 옆의 console.html (빌드가 dist로 복사, package.json build).
// 인라인 TS 템플릿 리터럴로 들고 있지 않는 이유: 700줄 HTML을 문자열로 품으면 이스케이프
// 지뢰밭이 되고 에디터 지원도 죽는다. 대신 "복사 누락"이라는 패키징 리스크가 생기는데,
// 그건 CI image 잡이 실제 컨테이너에서 /console을 curl해서 막는다 (P0에서 배운 교훈).

let cached: string | undefined;

export function consoleHtml(): string {
  cached ??= readFileSync(new URL("./console.html", import.meta.url), "utf8");
  return cached;
}

// Native IR 가이드 (HTML 렌더링) — 내용 원본은 docs/guides/native-ir.md.
// 포털 사용자는 저장소를 못 보므로 게이트웨이가 직접 서빙한다.
let cachedDocs: string | undefined;

export function docsHtml(): string {
  cachedDocs ??= readFileSync(new URL("./docs.html", import.meta.url), "utf8");
  return cachedDocs;
}
