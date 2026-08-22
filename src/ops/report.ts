import type { QueryableLedger, UsageAggregate } from "../state/types.js";
import { GatewayError, irError } from "../gateway/errors.js";

// 정산 리포트 (ADR-0007 §4) — 확정 원장 기준, 멱등 재생성. JSON/CSV.

export interface ReportQuery {
  from: string;
  to: string;
  groupBy: "model" | "provider" | "keyId" | "tenant";
  tenant?: string;
  format: "json" | "csv";
}

export function parseReportQuery(q: Record<string, string | undefined>): ReportQuery {
  const groupBy = q["groupBy"] ?? "model";
  if (!["model", "provider", "keyId", "tenant"].includes(groupBy)) {
    throw new GatewayError(irError("invalid_request", 400, `groupBy는 model|provider|keyId|tenant 중 하나 (${groupBy})`));
  }
  const format = q["format"] ?? "json";
  if (!["json", "csv"].includes(format)) {
    throw new GatewayError(irError("invalid_request", 400, `format은 json|csv (${format})`));
  }
  const from = q["from"] ?? "1970-01-01T00:00:00Z";
  const to = q["to"] ?? "9999-12-31T23:59:59Z";
  return {
    from,
    to,
    groupBy: groupBy as ReportQuery["groupBy"],
    ...(q["tenant"] ? { tenant: q["tenant"] } : {}),
    format: format as ReportQuery["format"],
  };
}

export async function usageReport(ledger: QueryableLedger, query: ReportQuery): Promise<UsageAggregate[]> {
  return ledger.aggregate({
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    ...(query.tenant ? { tenant: query.tenant } : {}),
  });
}

export function toCsv(rows: UsageAggregate[]): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = "group,requests,input_tokens,output_tokens,total_tokens,cost_usd";
  const lines = rows.map((r) =>
    [r.group, r.requests, r.inputTokens, r.outputTokens, r.totalTokens, r.costUsd.toFixed(6)].map(esc).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
