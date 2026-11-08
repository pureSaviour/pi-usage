import type { Account, Field } from "./config.ts";
import type { QueryAuth } from "./auth.ts";
import { requestJson } from "./http.ts";
import { array, numeric, object, quota, text, timestamp, UsageError, type Metric, type Snapshot } from "./types.ts";

// Deliberately a field path, not JSONPath/eval. Own properties only.
export function atPath(root: unknown, path: string): unknown {
  if (path === "$" || path === "") return root;
  const parts = path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".");
  let value = root;
  for (const part of parts) {
    if (!part || ["__proto__", "prototype", "constructor"].includes(part) || value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function field(root: unknown, f?: Field): unknown {
  if (!f) return undefined;
  const value = f.path !== undefined ? atPath(root, f.path) : f.value;
  if (f.scale === undefined) return value;
  const n = numeric(value);
  return n === undefined ? undefined : n * f.scale;
}
function interpolate(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    if (key === "token") {
      if (!token) throw new UsageError("missing-auth", "自定义请求引用了 ${token}，但未启用 usePiAuth 或 tokenEnv。");
      return token;
    }
    if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new UsageError("error", "请求模板只支持 ${token} 和 ${env:NAME}。");
    const result = process.env[key.slice(4)];
    if (!result) throw new UsageError("missing-auth", `缺少环境变量 ${key.slice(4)}。`);
    return result;
  });
  if (Array.isArray(value)) return value.map(v => interpolate(v, token));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, token)]));
  return value;
}
export async function queryCustom(account: Account, auth: QueryAuth | undefined, signal: AbortSignal): Promise<Snapshot> {
  const request = account.request!;
  const mapping = account.response!;
  // Auth is opt-in for arbitrary endpoints. Do not copy Pi headers to them.
  const expanded = object(interpolate(request, auth?.token ?? ""));
  const headers = new Headers(expanded.headers as Record<string, string> | undefined);
  headers.set("accept", "application/json");
  if (expanded.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const data = await requestJson(String(expanded.url), {
    method: request.method ?? "GET", headers,
    body: expanded.body === undefined ? undefined : JSON.stringify(expanded.body),
  }, signal, request.allowHttp);
  if (mapping.success && atPath(data, mapping.success.path) !== mapping.success.equals)
    throw new UsageError("error", "接口返回业务失败状态（response.success 未满足）；未解析余额。");
  const metrics: Metric[] = [];
  for (const m of mapping.metrics) {
    const roots = m.itemsPath !== undefined ? array(atPath(data, m.itemsPath)) : [data];
    if (roots.length > 100) throw new UsageError("error", "自定义查询单个指标最多支持 100 个数组元素。");
    for (const root of roots) {
      const remaining = numeric(field(root, m.remaining));
      const remainingPercent = numeric(field(root, m.remainingPercent));
      const values = {
        remaining, used: numeric(field(root, m.used)), limit: numeric(field(root, m.limit)),
        usedPercent: numeric(field(root, m.usedPercent)) ?? (remainingPercent === undefined ? undefined : 100 - remainingPercent),
        unit: text(field(root, m.unit)), resetAt: timestamp(field(root, m.resetAt), m.resetFormat),
        unlimited: field(root, m.unlimited) === true,
      };
      if (m.kind === "balance") {
        if (remaining !== undefined && values.unit) metrics.push({ label: m.label, kind: "balance", remaining, unit: values.unit });
      } else {
        const metric = quota(m.label, values);
        if (metric) metrics.push(metric);
      }
    }
  }
  if (!metrics.length) throw new UsageError("error", "响应中没有匹配到有效余额/配额，请检查字段路径或接口结构。");
  return {
    metrics,
    plan: text(field(data, mapping.plan)),
    notes: ["自定义 HTTP 查询"],
  };
}
