import { beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_KEYS } from "../ir/common.js";
import { bootstrapProviders } from "./bootstrap.js";
import { MODEL_ROUTES, getProvider, matchRoute, registeredProviders } from "./registry.js";
import { PRICE_TABLE, isPricedModel } from "./pricing.js";
import { SERVER_STATE_KEYS } from "./retarget.js";
import { DELETE_PATHS, REFERENCE_KEYS, RESPONSE_RESOURCES } from "../ops/resources.js";
import { FILE_PROVIDERS } from "../bridge/files.js";
import { BATCH_PROVIDERS } from "../bridge/batches.js";

// 프로바이더 등록 완전성 (리뷰 2026-08-22 어댑터 전수조사의 최대 리스크).
//
// 코어에 프로바이더 분기문은 없다(D4 준수). 대신 프로바이더 지식이 **키 기반 데이터 테이블
// 9곳**에 흩어져 있고, 지금까지 어느 것도 완전성을 강제하지 않았다 — "N+M" 약속의 실제
// 비용은 어댑터 1개가 아니라 어댑터 1개 + 등록 9곳이다.
//
// 누락의 위험도가 균일하지 않은 것이 핵심 문제다:
//   · FILE_PROVIDERS·BATCH_PROVIDERS 누락 → 명시적 501 (안전)
//   · PRICE_TABLE 누락            → **조용히 틀린 금액**
//   · SERVER_STATE_KEYS 누락      → **조용한 PO 누수** (xai 네임스페이스 누수가 이 계열이었다)
//
// 이 스위트의 계약: 누락은 실패한다. 통과시키려면 **명시적 면제 + 사유**를 아래 표에
// 적어야 한다 — 조용한 빠뜨림을 의도적 결정으로 바꾸는 것이 목적이다.

process.env["ANTHROPIC_API_KEY"] ??= "test-key";
beforeAll(() => bootstrapProviders());

/** 면제: 등록하지 않는 것이 옳은 경우만. 사유 없이 추가 금지 */
const EXEMPT: Record<string, Partial<Record<string, string>>> = {
  // REFERENCE_KEYS.anthropic은 면제가 아니라 `{}`로 **명시 등록**돼 있다 —
  // "검토했고 해당 참조 키 없음"을 빈 객체로 표현하는 쪽이 생략보다 낫다 (이 스위트가 그 차이를 강제한다)
  RESPONSE_RESOURCES: {
    google: "cachedContent는 게이트웨이가 생성하지 않는다 — 사용자가 만든 것을 참조만 (ADR-0006 §3)",
  },
  DELETE_PATHS: {
    anthropic: "container 삭제 API 없음 — 프로바이더 자체 TTL에 위임, 참조 차단으로 대체 (한계 명문화)",
    google: "cachedContent 삭제 API 미배선 — 프로바이더 자체 TTL에 위임",
  },
  FILE_PROVIDERS: {
    xai: "업로드 wire 세부 미확보 — providerOps가 명시적 501(files-unsupported)로 거부 (부록 (b) §2)",
  },
};

const PROVIDER_TABLES: Array<{ name: string; keys: readonly string[] }> = [
  { name: "SERVER_STATE_KEYS", keys: Object.keys(SERVER_STATE_KEYS) },
  { name: "REFERENCE_KEYS", keys: Object.keys(REFERENCE_KEYS) },
  { name: "RESPONSE_RESOURCES", keys: Object.keys(RESPONSE_RESOURCES) },
  { name: "DELETE_PATHS", keys: Object.keys(DELETE_PATHS) },
  { name: "FILE_PROVIDERS", keys: Object.keys(FILE_PROVIDERS) },
  { name: "BATCH_PROVIDERS", keys: Object.keys(BATCH_PROVIDERS) },
];

describe("프로바이더 등록 완전성", () => {
  it("PROVIDER_KEYS = 실제 등록된 프로바이더 (죽은 상수 방지)", () => {
    // PROVIDER_KEYS는 선언만 되고 아무도 안 쓰는 상수였다 — 여기서 canonical 목록으로 살린다
    expect([...registeredProviders()].sort()).toEqual([...PROVIDER_KEYS].sort());
  });

  it.each(PROVIDER_TABLES)("$name에 전 프로바이더가 등재됐다 (면제는 사유 필수)", ({ name, keys }) => {
    const registered = new Set(keys);
    const missing = registeredProviders().filter((p) => !registered.has(p) && !EXEMPT[name]?.[p]);
    expect(
      missing,
      `${name}에 ${missing.join(", ")} 누락 — 등록하거나 EXEMPT에 사유와 함께 명시할 것`,
    ).toEqual([]);
  });

  it("면제 목록에 유령 항목이 없다 (등록됐는데 면제로 남아 있는 경우)", () => {
    const stale: string[] = [];
    for (const [table, exemptions] of Object.entries(EXEMPT)) {
      const keys = new Set(PROVIDER_TABLES.find((t) => t.name === table)?.keys ?? []);
      for (const provider of Object.keys(exemptions)) {
        if (keys.has(provider)) stale.push(`${table}.${provider}`);
      }
    }
    expect(stale, `등록됐으므로 EXEMPT에서 제거할 것: ${stale.join(", ")}`).toEqual([]);
  });

  it("모든 테이블 키가 실제 등록된 프로바이더다 (오타·유령 키 방지)", () => {
    const known = new Set(registeredProviders());
    const ghosts: string[] = [];
    for (const { name, keys } of PROVIDER_TABLES) {
      for (const key of keys) if (!known.has(key)) ghosts.push(`${name}.${key}`);
    }
    expect(ghosts).toEqual([]);
  });
});

describe("모델 라우팅 완전성 (라우트별 대표 모델)", () => {
  it("모든 라우트가 sample을 선언한다", () => {
    const nameless = MODEL_ROUTES.filter((r) => !r.sample || r.sample.length === 0);
    expect(nameless.map((r) => String(r.pattern))).toEqual([]);
  });

  it.each(MODEL_ROUTES.map((r) => ({ pattern: String(r.pattern), route: r })))(
    "$pattern — sample이 자기 라우트에 매칭된다 (정규식 오류·앞 라우트 가려짐 검출)",
    ({ route }) => {
      const matched = matchRoute(route.sample);
      // 참조 동일성 — 앞선 라우트에 가려지면 다른 객체가 나온다
      expect(
        matched,
        `${route.sample}이 ${String(route.pattern)}이 아니라 ${String(matched?.pattern)}에 매칭됨`,
      ).toBe(route);
    },
  );

  it("모든 라우트의 provider가 등록돼 있다", () => {
    const known = new Set(registeredProviders());
    const unknown = MODEL_ROUTES.filter((r) => !known.has(r.provider)).map((r) => r.provider);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("라우트의 capability surfaces가 실제 등록된 표면이다", () => {
    const bad: string[] = [];
    for (const route of MODEL_ROUTES) {
      const surfaces = route.capabilities?.surfaces;
      if (!surfaces) continue;
      const registered = getProvider(route.provider).adapters;
      for (const surface of surfaces) {
        if (!registered.has(surface)) bad.push(`${route.sample}: ${route.provider}/${surface}`);
      }
    }
    expect(bad, `capability가 미등록 표면을 가리킨다: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("가격표 완전성 (조용히 틀린 금액 방지)", () => {
  /** 실단가 미확보 모델 — 폴백 근사 + `billing-price-estimated` warning으로 운영된다 */
  const UNPRICED_KNOWN: Record<string, string> = {
    "claude-opus-5": "실단가 미확보 — 확보 시 PRICE_TABLE 등재 (현재 폴백 근사 + warning)",
    "claude-sonnet-5": "실단가 미확보 — 세대 게이트 라우트 분리로 신규 sample (감사 anthropic #2)",
    "gpt-5.6-pro": "gpt-5.6 접두 과소 과금 방지용 PREFIX_EXCLUDES (감사 #32) — pro 실단가 확보 시 정식 등재",
    "computer-use-preview": "실단가 미확보 — 사용 실적 없음",
    "gpt-audio": "오디오 단가는 토큰 외 축(초당) — 가격표 모델 확장 필요",
    "gpt-5.4": "구세대 — 사용 실적 없음",
    "gpt-4.1": "구세대 — 사용 실적 없음",
    "gemini-3.1-pro": "실단가 미확보",
    "gemini-2.5-flash": "구세대 — 사용 실적 없음",
    "gemini-2.0-flash": "구세대 — 사용 실적 없음",
    "grok-4.5": "실단가 미확보",
    "grok-4.3-non-reasoning": "실단가 미확보",
    "grok-4.3": "실단가 미확보",
  };

  it("가격표 미등재 모델은 전부 UNPRICED_KNOWN에 사유가 있다", () => {
    const silent = MODEL_ROUTES.filter((r) => !isPricedModel(r.sample) && !UNPRICED_KNOWN[r.sample]).map(
      (r) => r.sample,
    );
    expect(
      silent,
      `가격표에 없고 사유도 없다 — PRICE_TABLE에 등재하거나 UNPRICED_KNOWN에 사유를 적을 것: ${silent.join(", ")}`,
    ).toEqual([]);
  });

  it("UNPRICED_KNOWN에 유령 항목이 없다 (가격 등재 후 남은 잔재)", () => {
    const stale = Object.keys(UNPRICED_KNOWN).filter((m) => isPricedModel(m));
    expect(stale, `가격표에 등재됐으므로 UNPRICED_KNOWN에서 제거할 것: ${stale.join(", ")}`).toEqual([]);
  });

  it("가격표의 모든 접두가 실제 라우팅되는 모델이다 (죽은 단가 방지)", () => {
    const unroutable = PRICE_TABLE.filter((e) => matchRoute(e.prefix) === undefined).map((e) => e.prefix);
    expect(unroutable, `라우팅 불가 접두: ${unroutable.join(", ")}`).toEqual([]);
  });
});
