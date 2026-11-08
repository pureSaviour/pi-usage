export interface Metric {
  label: string;
  kind: "balance" | "quota";
  remaining?: number;
  used?: number;
  limit?: number;
  usedPercent?: number;
  unit?: string;
  resetAt?: string;
  unlimited?: boolean;
}
export interface Snapshot {
  metrics: Metric[];
  plan?: string;
  notes?: string[];
}
export interface ModelUsage {
  provider: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  calls: number;
  providerReported: boolean;
}
export interface SessionUsage extends Omit<ModelUsage, "provider" | "model"> {
  models: ModelUsage[];
}
export interface Result {
  id: string;
  name: string;
  provider: string;
  status: "ok" | "unsupported" | "missing-auth" | "error";
  snapshot?: Snapshot;
  /** Resolved credential kind, retained even when the query fails. */
  auth?: "api" | "oauth";
  sessionUsage?: SessionUsage;
  message?: string;
  checkedAt: string;
}
export class UsageError extends Error {
  readonly status: Exclude<Result["status"], "ok">;
  constructor(status: Exclude<Result["status"], "ok">, message: string) {
    super(message);
    this.status = status;
  }
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function timestamp(value: unknown, format: "auto" | "seconds" | "milliseconds" = "auto"): string | undefined {
  const n = numeric(value);
  const ms = n === undefined ? Date.parse(String(value)) :
    format === "seconds" ? n * 1000 : format === "milliseconds" ? n : n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : undefined;
}
export function quota(label: string, values: Omit<Metric, "label" | "kind">): Metric | undefined {
  const m: Metric = { label, kind: "quota", ...values };
  if (m.unlimited) return m;
  if (m.used === undefined && m.remaining !== undefined && m.limit !== undefined) m.used = numeric(m.limit - m.remaining);
  if (m.remaining === undefined && m.used !== undefined && m.limit !== undefined) m.remaining = numeric(Math.max(0, m.limit - m.used));
  if (m.usedPercent === undefined && m.used !== undefined && m.limit !== undefined && m.limit > 0)
    m.usedPercent = numeric(m.used / m.limit * 100);
  return [m.remaining, m.used, m.usedPercent].some(v => v !== undefined && Number.isFinite(v)) ? m : undefined;
}
export function compact(metrics: (Metric | undefined)[]): Metric[] {
  return metrics.filter((m): m is Metric => m !== undefined);
}
