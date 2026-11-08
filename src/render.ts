import type { Result, Metric, SessionUsage } from "./types.ts";

export function safe(value: string): string {
  // API-controlled text must not inject terminal escapes or additional UI lines.
  return withoutParentheses(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 350));
}
/** Remove presentation asides, including nested ASCII/Chinese parentheses. */
export function withoutParentheses(value: string): string {
  let previous: string;
  do {
    previous = value;
    value = value.replace(/\([^()]*\)|（[^（）]*）/g, "");
  } while (value !== previous);
  return value.replace(/(\S)[ \t]{2,}/g, "$1 ").trimEnd();
}
const number = (n: number, digits = 4) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const cost = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Minimal footer: login/account name plus the primary remaining amount. */
export function renderFooter(result: Result): string {
  const name = safe(result.name).trim().slice(0, 28);
  if (result.status !== "ok") {
    const reason = { unsupported: "暂不支持直查", "missing-auth": "需认证", error: "查询失败" }[result.status];
    return `${name} · ${reason}`;
  }
  const metrics = result.snapshot?.metrics ?? [];
  const balance = metrics.find(m => m.kind === "balance" && m.remaining !== undefined);
  if (balance?.remaining !== undefined) return `${name} · 余额 ${number(balance.remaining)}${balance.unit ? " " + safe(balance.unit) : ""}`;
  const quota = metrics.find(m => m.kind === "quota");
  if (quota) {
    if (quota.unlimited) return `${name} · 不限量`;
    if (quota.usedPercent !== undefined) return `${name} · 剩余 ${number(Math.max(0, 100 - quota.usedPercent), 1)}%`;
    if (quota.remaining !== undefined) return `${name} · 剩余 ${number(quota.remaining)}${quota.unit ? " " + safe(quota.unit) : ""}`;
  }
  return `${name} · 未提供剩余额度`;
}

function metricLine(m: Metric): string {
  const parts: string[] = [];
  if (m.unlimited) parts.push("不限量");
  else {
    if (m.remaining !== undefined) parts.push(`剩余 ${number(m.remaining)}${m.unit ? " " + safe(m.unit) : ""}`);
    if (m.limit !== undefined) parts.push(`限额 ${number(m.limit)}${m.unit ? " " + safe(m.unit) : ""}`);
    if (m.usedPercent !== undefined) {
      const remainingPercent = Math.max(0, 100 - m.usedPercent);
      const filled = Math.max(0, Math.min(16, Math.round(remainingPercent / 100 * 16)));
      parts.push(`[${"█".repeat(filled)}${"░".repeat(16 - filled)}] 剩余 ${number(remainingPercent)}% · 已用 ${number(m.usedPercent)}%`);
    } else if (m.used !== undefined) parts.push(`已用 ${number(m.used)}${m.unit ? " " + safe(m.unit) : ""}`);
  }
  if (m.resetAt) parts.push(`重置 ${new Date(m.resetAt).toLocaleString()}`);
  return `  ${safe(m.label)}：${parts.join(" · ")}`;
}

function sessionLine(usage: SessionUsage): string[] {
  const source = usage.providerReported ? "提供商返回的费用" : usage.models.some(model => model.providerReported)
    ? "Pi 价格表估算与提供商上报混合，非账户账单" : "Pi 价格表估算，非提供商账单";
  if (!usage.calls) return ["  本次会话尚无已记录的模型调用。"];
  const lines = [
    `  合计：${cost(usage.cost)} USD · ${usage.calls} 次调用 · ${number(usage.totalTokens, 0)} tokens`,
    `  费用口径：${source}`,
  ];
  for (const model of usage.models) {
    const tokenParts = [
      `输入 ${number(model.inputTokens, 0)}`,
      `输出 ${number(model.outputTokens, 0)}`,
      `缓存读 ${number(model.cacheReadTokens, 0)}`,
    ];
    if (model.cacheWriteTokens) tokenParts.push(`缓存写 ${number(model.cacheWriteTokens, 0)}`);
    lines.push(
      `  ${safe(model.model)}：${cost(model.cost)} USD · ${model.calls} 次 · ${number(model.totalTokens, 0)} tokens`,
      `    ${tokenParts.join(" · ")}${model.providerReported ? " · 含提供商上报费用" : ""}`,
    );
  }
  return lines;
}

export function renderResults(results: Result[]): string[] {
  const lines = ["pi-usage · 账户余额 / 订阅配额 / 会话用量"];
  for (const result of results) {
    const auth = result.auth === "api" ? "API 认证" : result.auth === "oauth" ? "订阅认证" : undefined;
    lines.push("", `${safe(result.name)}${auth ? " · " + auth : ""}${result.snapshot?.plan ? " · " + safe(result.snapshot.plan) : ""}`);
    if (result.status !== "ok") {
      const status = { unsupported: "不支持", "missing-auth": "需要凭据", error: "查询失败" }[result.status];
      lines.push(`  ${status}：${safe(result.message ?? "")}`);
    } else {
      lines.push(...result.snapshot!.metrics.map(metricLine));
      for (const note of result.snapshot!.notes ?? []) lines.push(`  提示：${safe(note)}`);
    }
    if (result.sessionUsage) {
      lines.push("", "  本次会话用量：");
      lines.push(...sessionLine(result.sessionUsage));
    }
    lines.push(`  查询时间：${new Date(result.checkedAt).toLocaleString()}`);
  }
  return lines.map(withoutParentheses);
}
