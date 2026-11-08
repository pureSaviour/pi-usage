import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { object, UsageError } from "./types.ts";

export interface Field {
  path?: string;
  value?: string | number | boolean;
  scale?: number;
}
export interface MetricMapping {
  kind: "balance" | "quota";
  label: string;
  itemsPath?: string;
  remaining?: Field;
  used?: Field;
  limit?: Field;
  usedPercent?: Field;
  remainingPercent?: Field;
  unit?: Field;
  resetAt?: Field;
  resetFormat?: "auto" | "seconds" | "milliseconds";
  unlimited?: Field;
}
export interface Account {
  id: string;
  name?: string;
  provider: string;
  adapter?: string;
  tokenEnv?: string;
  enabled?: boolean;
  request?: {
    url: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
    allowHttp?: boolean;
    usePiAuth?: boolean;
  };
  response?: {
    metrics: MetricMapping[];
    plan?: Field;
    success?: { path: string; equals: string | number | boolean };
  };
}
export interface Config {
  version: 1;
  timeoutMs: number;
  accounts: Account[];
  disabledProviders: string[];
}
export function configPath(): string {
  return process.env.PI_USAGE_CONFIG ? resolve(process.env.PI_USAGE_CONFIG) : join(getAgentDir(), "pi-usage.json");
}
function fail(location: string): never {
  throw new UsageError("error", `配置格式错误：${location}。请参考 examples/pi-usage.json。`);
}
function onlyKeys(o: Record<string, unknown>, allowed: string[], location: string): void {
  if (Object.keys(o).some(k => !allowed.includes(k))) fail(`${location} 有未知字段`);
}
function validField(value: unknown): value is Field {
  const f = object(value);
  return Object.keys(f).length > 0 && Object.keys(f).every(k => ["path", "value", "scale"].includes(k)) &&
    ((typeof f.path === "string" && !("value" in f)) ||
     (!("path" in f) && ["string", "number", "boolean"].includes(typeof f.value) && (typeof f.value !== "number" || Number.isFinite(f.value)))) &&
    (f.scale === undefined || (typeof f.scale === "number" && Number.isFinite(f.scale)));
}
export async function loadConfig(): Promise<Config> {
  let raw: string;
  try { raw = await readFile(configPath(), "utf8"); }
  catch (error) {
    if (object(error).code === "ENOENT") return { version: 1, timeoutMs: 15000, accounts: [], disabledProviders: [] };
    throw new UsageError("error", "无法读取 pi-usage 配置文件。");
  }
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(raw)); }
  catch { throw new UsageError("error", "pi-usage 配置不是有效 JSON。"); }
  onlyKeys(data, ["version", "timeoutMs", "accounts", "disabledProviders"], "根对象");
  if (data.version !== 1) fail("version 必须为 1");
  const timeoutMs = data.timeoutMs ?? 15000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) fail("timeoutMs 应为 1000–60000 的整数");
  const disabled = data.disabledProviders ?? [];
  if (!Array.isArray(disabled) || !disabled.every(v => typeof v === "string")) fail("disabledProviders 应为字符串数组");
  const entries = data.accounts ?? [];
  if (!Array.isArray(entries) || entries.length > 100) fail("accounts 应为数组且最多 100 项");
  const ids = new Set<string>();
  for (const entry of entries) {
    const a = object(entry);
    onlyKeys(a, ["id", "name", "provider", "adapter", "tokenEnv", "enabled", "request", "response"], "account");
    if (typeof a.id !== "string" || !/^[a-zA-Z0-9][\w.-]*$/.test(a.id) || ["all", "help", "list", "clear", "on", "off", "refresh", "query"].includes(a.id) || ids.has(a.id)) fail("account.id 无效、重复或为保留字");
    ids.add(a.id);
    if (typeof a.provider !== "string" || !a.provider.trim()) fail(`${a.id}.provider`);
    for (const key of ["name", "adapter", "tokenEnv"]) if (a[key] !== undefined && (typeof a[key] !== "string" || !a[key])) fail(`${a.id}.${key}`);
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") fail(`${a.id}.enabled`);
    if (a.request !== undefined) {
      const r = object(a.request);
      onlyKeys(r, ["url", "method", "headers", "body", "allowHttp", "usePiAuth"], `${a.id}.request`);
      if (typeof r.url !== "string" || !r.url) fail(`${a.id}.request.url`);
      if (r.method !== undefined && r.method !== "GET" && r.method !== "POST") fail(`${a.id}.request.method`);
      if ((r.method ?? "GET") === "GET" && r.body !== undefined) fail(`${a.id} GET 不允许 body`);
      for (const key of ["allowHttp", "usePiAuth"]) if (r[key] !== undefined && typeof r[key] !== "boolean") fail(`${a.id}.request.${key}`);
      if (r.headers !== undefined && (r.headers === null || typeof r.headers !== "object" || Array.isArray(r.headers) || !Object.values(r.headers).every(v => typeof v === "string"))) fail(`${a.id}.request.headers`);
      const response = object(a.response);
      onlyKeys(response, ["metrics", "plan", "success"], `${a.id}.response`);
      if (!Array.isArray(response.metrics) || response.metrics.length === 0 || response.metrics.length > 100) fail(`${a.id}.response.metrics`);
      if (response.plan !== undefined && !validField(response.plan)) fail(`${a.id}.response.plan`);
      if (response.success !== undefined) {
        const s = object(response.success);
        onlyKeys(s, ["path", "equals"], `${a.id}.response.success`);
        if (typeof s.path !== "string" || !["string", "number", "boolean"].includes(typeof s.equals)) fail(`${a.id}.response.success`);
      }
      for (const metric of response.metrics) {
        const m = object(metric);
        onlyKeys(m, ["kind", "label", "itemsPath", "remaining", "used", "limit", "usedPercent", "remainingPercent", "unit", "resetAt", "resetFormat", "unlimited"], `${a.id}.metric`);
        if ((m.kind !== "balance" && m.kind !== "quota") || typeof m.label !== "string" || !m.label.trim()) fail(`${a.id}.metric kind/label`);
        if (m.itemsPath !== undefined && typeof m.itemsPath !== "string") fail(`${a.id}.metric.itemsPath`);
        if (m.resetFormat !== undefined && m.resetFormat !== "auto" && m.resetFormat !== "seconds" && m.resetFormat !== "milliseconds") fail(`${a.id}.metric.resetFormat`);
        for (const key of ["remaining", "used", "limit", "usedPercent", "remainingPercent", "unit", "resetAt", "unlimited"])
          if (m[key] !== undefined && !validField(m[key])) fail(`${a.id}.metric.${key}`);
        if (m.kind === "balance" && (m.remaining === undefined || m.unit === undefined)) fail(`${a.id} balance 需要 remaining 和 unit`);
      }
    } else if (a.response !== undefined) fail(`${a.id}.response 需要 request`);
  }
  return { version: 1, timeoutMs, accounts: entries as Account[], disabledProviders: disabled as string[] };
}
