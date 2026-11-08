import type { Account } from "./config.ts";
import type { QueryAuth } from "./auth.ts";
import { requestJson } from "./http.ts";
import { array, compact, numeric, object, quota, text, timestamp, UsageError, type Metric, type Snapshot } from "./types.ts";

export const BUILTINS: Record<string, { name: string; experimental?: boolean }> = Object.assign(Object.create(null), {
  deepseek: { name: "DeepSeek" },
  openai: { name: "OpenAI / ChatGPT", experimental: true },
  "openai-codex": { name: "ChatGPT / Codex", experimental: true },
  anthropic: { name: "Anthropic / Claude", experimental: true },
  "github-copilot": { name: "GitHub Copilot", experimental: true },
  "kimi-coding": { name: "Kimi Code", experimental: true },
  openrouter: { name: "OpenRouter" },
  moonshotai: { name: "Moonshot AI" },
  "moonshotai-cn": { name: "Moonshot AI 中国" },
  zai: { name: "Z.ai Coding Plan", experimental: true },
  "zai-coding-cn": { name: "智谱 Coding Plan", experimental: true },
  minimax: { name: "MiniMax Coding Plan", experimental: true },
  "minimax-cn": { name: "MiniMax 中国 Coding Plan", experimental: true },
  "vercel-ai-gateway": { name: "Vercel AI Gateway" },
  siliconflow: { name: "SiliconFlow" },
});
const UNSUPPORTED: Record<string, string> = {
  google: "Gemini API key 不提供账户余额/订阅配额查询；Google Cloud 账单需要单独权限。",
  "google-gemini-cli": "Gemini CLI OAuth 配额查询暂未内置；可通过自定义 HTTP 查询接入。",
  "google-antigravity": "Antigravity 配额查询暂未内置；可通过自定义 HTTP 查询接入。",
  "amazon-bedrock": "AWS 账单需要独立的 Cost Explorer 权限；推理凭据不能代表账户余额。",
  "google-vertex": "Google Cloud 账单需要独立权限，不能使用模型推理 key 查询账户余额。",
  azure: "Azure 订阅账单需要单独的 Azure 管理权限。",
};
export function unsupported(provider: string): never {
  throw new UsageError("unsupported", Object.hasOwn(UNSUPPORTED, provider) ? UNSUPPORTED[provider] : "尚无内置账户余额/配额查询。可在用户配置中添加自定义 HTTP 查询。");
}
function balance(label: string, value: unknown, unit: string | undefined): Metric | undefined {
  const remaining = numeric(value);
  return remaining === undefined || !unit ? undefined : { kind: "balance", label, remaining, unit };
}
function bearer(auth: QueryAuth, extra: Record<string, string> = {}): Record<string, string> {
  // Do not forward model-specific headers to a different billing host.
  return { Authorization: `Bearer ${auth.token}`, Accept: "application/json", "User-Agent": "pi-usage/0.1.0", ...extra };
}
function requireMetrics(snapshot: Snapshot): Snapshot {
  if (!snapshot.metrics.length) throw new UsageError("error", "接口未返回可识别的余额/配额；此账户可能无此配额或接口结构已变更。");
  return snapshot;
}
function codexWindows(value: unknown, prefix = ""): Metric[] {
  const rate = object(value);
  return compact(["primary_window", "secondary_window"].map((key, i) => {
    const w = object(rate[key]);
    const seconds = numeric(w.limit_window_seconds);
    const label = seconds === 18000 ? "5 小时" : seconds === 604800 ? "周限额" : seconds ? `${seconds / 3600} 小时` : i === 0 ? "主窗口（周期未提供）" : "次窗口（周期未提供）";
    const reset = timestamp(w.reset_at) ?? (numeric(w.reset_after_seconds) === undefined ? undefined : timestamp(Date.now() + numeric(w.reset_after_seconds)! * 1000, "milliseconds"));
    return quota(`${prefix}${label}`, { usedPercent: numeric(w.used_percent), resetAt: reset });
  }));
}
export async function queryBuiltin(account: Account, auth: QueryAuth, signal: AbortSignal): Promise<Snapshot> {
  const adapter = account.adapter ?? account.provider;
  const get = async (url: string, headers = bearer(auth)) => object(await requestJson(url, { headers }, signal));
  let snapshot: Snapshot;
  switch (adapter) {
    case "deepseek": {
      const data = await get("https://api.deepseek.com/user/balance");
      snapshot = { metrics: compact(array(data.balance_infos).flatMap(value => {
        const row = object(value); const unit = text(row.currency);
        return [balance("账户总余额", row.total_balance, unit), balance("充值余额", row.topped_up_balance, unit), balance("赠送余额", row.granted_balance, unit)];
      })), notes: data.is_available === false ? ["服务方标记账户当前不可用。"] : [] };
      break;
    }
    case "openai":
    case "openai-codex": {
      if (auth.openAIDirect)
        throw new UsageError("unsupported", "已识别新 OpenAI / ChatGPT Plan Usage 认证；该令牌面向 api.openai.com，不能用于旧 Codex 的 wham/usage。当前尚无已核实的直接配额查询接口，请在 https://chatgpt.com/settings/usage 查看。无需为此重新登录；如已单独登录旧 Codex，可用 /usage openai-codex 查询其配额（不代表新授权配额）。");
      if (adapter === "openai" && !auth.oauth && !auth.accountId)
        throw new UsageError("unsupported", "OpenAI API key 没有受支持的余额接口。新 ChatGPT Plan Usage 登录也暂不支持直接查询配额，请在 https://chatgpt.com/settings/usage 查看。");
      const headers = bearer(auth);
      if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
      const data = await get("https://chatgpt.com/backend-api/wham/usage", headers);
      const metrics = codexWindows(data.rate_limit);
      for (const entry of array(data.additional_rate_limits)) {
        const row = object(entry);
        metrics.push(...codexWindows(row.rate_limit, `${text(row.limit_name) ?? text(row.metered_feature) ?? "附加限额"} · `));
      }
      const credits = object(data.credits);
      const credit = quota("额外积分", { remaining: numeric(credits.balance), unit: "credits", unlimited: credits.unlimited === true });
      if (credit) metrics.push(credit);
      snapshot = { plan: text(data.plan_type), metrics, notes: ["非公开接口；展示 Codex 订阅配额，不代表 ChatGPT 网页所有模型的消息限额。未返回的窗口不会被推测为 100% 剩余。"] };
      break;
    }
    case "anthropic": {
      if (!auth.oauth && !auth.token.startsWith("sk-ant-oat"))
        throw new UsageError("unsupported", "Anthropic 普通 API key 无余额查询接口。Claude Pro/Max 配额需要 OAuth 凭据，且令牌需有 user:profile 等查询权限。");
      const data = await get("https://api.anthropic.com/api/oauth/usage", bearer(auth, { "anthropic-beta": "oauth-2025-04-20" }));
      const metrics = compact(Object.entries(data).filter(([key]) => key === "five_hour" || key.startsWith("seven_day")).map(([key, value]) => {
        const row = object(value);
        return quota(key === "five_hour" ? "5 小时" : key === "seven_day" ? "周限额" : key, { usedPercent: numeric(row.utilization), resetAt: timestamp(row.resets_at) });
      }));
      snapshot = { metrics, notes: ["非公开 OAuth 接口；普通 API 消费金额及额外用量账单不等于此订阅配额。"] };
      break;
    }
    case "github-copilot": {
      const data = await get("https://api.github.com/copilot_internal/user", {
        ...bearer(auth), Authorization: `token ${auth.token}`,
        "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7",
      });
      const metrics = compact(Object.entries(object(data.quota_snapshots)).map(([key, value]) => {
        const row = object(value); const percent = numeric(row.percent_remaining);
        const remaining = numeric(row.remaining); const limit = numeric(row.entitlement);
        // New token-billed seats may still return legacy 0/0/100% placeholders.
        if (row.unlimited !== true && limit === 0 && (remaining ?? 0) === 0) return undefined;
        return quota(key, { unlimited: row.unlimited === true, remaining,
          limit, usedPercent: percent === undefined ? undefined : 100 - percent,
          resetAt: timestamp(data.quota_reset_date), unit: "requests" });
      }));
      if (!metrics.length && data.token_based_billing === true)
        throw new UsageError("unsupported", "此 Copilot 账户使用 token 计费，接口未提供可用的订阅剩余额度；未将旧配额占位值作为真实额度展示。");
      snapshot = { plan: text(data.copilot_plan), metrics, notes: ["非公开接口。按接口返回的配额类别展示；不限量不等于金额余额。"] };
      break;
    }
    case "kimi-coding": {
      const data = await get("https://api.kimi.com/coding/v1/usages");
      const pools = object(data.usages);
      const metrics = compact(Object.entries(pools).map(([key, value]) => {
        const row = object(value); const ratio = numeric(row.used_ratio);
        const labels: Record<string, string> = { limit_5h: "5 小时", limit_7d: "周限额", limit_month_total: "月总配额", limit_month_code: "月 Code 用量（共享总配额）" };
        return ratio === undefined ? undefined : quota(labels[key] ?? key, { usedPercent: ratio * 100, resetAt: timestamp(row.reset_time) });
      }));
      if (!metrics.length) {
        const parse = (value: unknown, label: string) => {
          const row = object(value);
          return quota(label, { limit: numeric(row.limit), used: numeric(row.used), remaining: numeric(row.remaining), resetAt: timestamp(row.resetTime ?? row.resetAt ?? row.reset_time ?? row.reset_at) });
        };
        const weekly = parse(data.usage, "周配额"); if (weekly) metrics.push(weekly);
        for (const value of array(data.limits)) {
          const row = object(value); const window = object(row.window);
          const metric = parse(row.detail, `限额窗口 ${text(window.duration) ?? text(window.timeUnit) ?? ""}`.trim());
          if (metric) metrics.push(metric);
        }
      }
      snapshot = { metrics, plan: text(object(object(data.user).membership).level), notes: ["Kimi Code 查询接口；新旧响应格式均按服务端数据解析。"] };
      break;
    }
    case "openrouter": {
      const data = object((await get("https://openrouter.ai/api/v1/key")).data);
      const remaining = numeric(data.limit_remaining);
      const metrics: Metric[] = [];
      if (remaining !== undefined) metrics.push({ kind: "quota", label: "API key 预算（非账户余额）", remaining, used: numeric(data.usage), limit: numeric(data.limit), unit: "USD" });
      const notes: string[] = [];
      // A restricted key can expose its own budget while denying account credits.
      try {
        const credits = object((await get("https://openrouter.ai/api/v1/credits")).data);
        const total = numeric(credits.total_credits); const used = numeric(credits.total_usage);
        if (total !== undefined && used !== undefined) metrics.unshift({ kind: "balance", label: "账户余额", remaining: total - used, unit: "USD" });
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof UsageError)) throw error;
        notes.push("账户 credits 查询失败或权限不足；已保留可用的 API key 预算数据。");
      }
      if (!metrics.length) throw new UsageError("unsupported", "此 OpenRouter key 未返回账户余额，也没有有限 key 预算；无限预算不代表账户有无限余额。");
      snapshot = { metrics, notes };
      break;
    }
    case "moonshotai":
    case "moonshotai-cn": {
      const host = adapter === "moonshotai-cn" ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
      const response = await get(`${host}/v1/users/me/balance`);
      if (response.status === false) throw new UsageError("error", "Moonshot 返回业务失败状态。");
      const data = object(response.data);
      const unit = adapter === "moonshotai-cn" ? "CNY" : "USD";
      snapshot = { metrics: compact([balance("可用余额", data.available_balance, unit), balance("现金余额", data.cash_balance, unit), balance("代金券余额", data.voucher_balance, unit)]) };
      break;
    }
    case "zai":
    case "zai-coding-cn": {
      const host = adapter === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
      const response = await get(`${host}/api/monitor/usage/quota/limit`);
      if (response.success === false || (response.code !== undefined && ![0, 200, "0", "200"].includes(response.code as string | number)))
        throw new UsageError("error", "Coding Plan 查询返回业务失败状态。");
      const metrics = compact(array(object(response.data).limits).map(value => {
        const row = object(value);
        // Do not assume TOKENS_LIMIT always means five hours: weekly/monthly plans also exist.
        const label = `${text(row.type) ?? "配额"}${row.number !== undefined ? ` · ${String(row.number)}` : ""}${row.unit !== undefined ? ` (unit ${String(row.unit)})` : ""}`;
        return quota(label, { usedPercent: numeric(row.percentage), used: numeric(row.currentValue), limit: numeric(row.usage), remaining: numeric(row.remaining), resetAt: timestamp(row.nextResetTime) });
      }));
      snapshot = { metrics, notes: ["非公开 Coding Plan 接口；保留服务方窗口类型与 unit 编码，不猜测周期。"] };
      break;
    }
    case "minimax":
    case "minimax-cn": {
      const host = adapter === "minimax-cn" ? "https://api.minimaxi.com" : "https://api.minimax.io";
      const response = await get(`${host}/v1/api/openplatform/coding_plan/remains`);
      const data = Object.hasOwn(response, "data") ? object(response.data) : response;
      const code = numeric(object(data.base_resp ?? response.base_resp).status_code);
      if (code !== undefined && code !== 0) throw new UsageError("error", "MiniMax 返回业务失败状态；请确认使用 Coding Plan key。");
      const metrics = compact(array(data.model_remains).flatMap(value => {
        const row = object(value); const name = text(row.model_name) ?? "模型";
        // Despite the field name, *_usage_count here is REMAINING, not used.
        return [quota(`${name} · 当前窗口`, { remaining: numeric(row.current_interval_usage_count), limit: numeric(row.current_interval_total_count), resetAt: timestamp(row.end_time), unit: "requests" }),
          numeric(row.current_weekly_total_count)! > 0 ? quota(`${name} · 周限额`, { remaining: numeric(row.current_weekly_usage_count), limit: numeric(row.current_weekly_total_count), resetAt: timestamp(row.weekly_end_time), unit: "requests" }) : undefined];
      }));
      snapshot = { metrics, plan: text(data.plan_name), notes: ["非公开 Coding Plan 接口；不代表 MiniMax 普通 API 充值余额。"] };
      break;
    }
    case "vercel-ai-gateway": {
      const data = await get("https://ai-gateway.vercel.sh/v1/credits");
      snapshot = { metrics: compact([balance("可用余额", data.balance, "USD")]) };
      break;
    }
    case "siliconflow": {
      const response = await get("https://api.siliconflow.cn/v1/user/info");
      if (response.code !== undefined && response.code !== 20000 && response.code !== 0) throw new UsageError("error", "SiliconFlow 返回业务失败状态。");
      const data = object(response.data);
      snapshot = { metrics: compact([balance("账户总余额", data.totalBalance, "CNY"), balance("充值余额", data.chargeBalance, "CNY"), balance("赠送余额", data.balance, "CNY")]) };
      break;
    }
    default: return unsupported(adapter);
  }
  return requireMetrics(snapshot);
}
