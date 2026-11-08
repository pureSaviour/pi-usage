import { numeric, object, text, type SessionUsage, type ModelUsage } from "./types.ts";

/** One pass over the current branch, shared by all query accounts. Not an invoice. */
export function summarizeSessionUsage(entries: readonly unknown[]): Map<string, SessionUsage> {
  const providers = new Map<string, { total: SessionUsage; models: Map<string, ModelUsage> }>();
  for (const value of entries) {
    const entry = object(value);
    const message = entry.type === "message" ? object(entry.message) : entry;
    if (entry.type === "message" ? message.role !== "assistant" : entry.type !== "usage") continue;
    const provider = text(message.provider);
    const model = text(message.model);
    const usage = object(message.usage);
    const cost = object(usage.cost);
    const costTotal = numeric(cost.total);
    if (!provider || !model || costTotal === undefined) continue;
    const input = numeric(usage.input) ?? 0;
    const output = numeric(usage.output) ?? 0;
    const cacheRead = numeric(usage.cacheRead) ?? 0;
    const cacheWrite = numeric(usage.cacheWrite) ?? 0;
    const tokens = numeric(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
    const group = providers.get(provider) ?? {
      total: emptyUsage(),
      models: new Map<string, ModelUsage>(),
    };
    const item = group.models.get(model) ?? { ...emptyCounters(), provider, model, providerReported: false };
    for (const target of [item, group.total]) {
      target.cost += costTotal;
      target.inputTokens += input;
      target.outputTokens += output;
      target.cacheReadTokens += cacheRead;
      target.cacheWriteTokens += cacheWrite;
      target.totalTokens += tokens;
      target.calls++;
    }
    // Per-model flag means "contains reported cost"; the total flag means
    // "every call reported cost", so mixed data is never labelled an invoice.
    item.providerReported ||= cost.totalFromProvider === true;
    group.total.providerReported &&= cost.totalFromProvider === true;
    group.models.set(model, item);
    providers.set(provider, group);
  }
  const result = new Map<string, SessionUsage>();
  for (const [provider, group] of providers) {
    group.total.models = [...group.models.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    result.set(provider, group.total);
  }
  return result;
}

function emptyCounters(): Omit<SessionUsage, "models"> {
  return {
    cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0, calls: 0, providerReported: true,
  };
}
export function emptyUsage(): SessionUsage {
  return { ...emptyCounters(), models: [] };
}
