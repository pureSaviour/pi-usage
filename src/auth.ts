import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Account } from "./config.ts";
import { object, text, UsageError } from "./types.ts";

export interface QueryAuth {
  token: string;
  oauth: boolean;
  accountId?: string;
  openAIDirect?: boolean;
}
function openAIMetadata(token: string): Pick<QueryAuth, "accountId" | "openAIDirect"> {
  // Routing hints only, not identity verification. Never log or expose claims.
  try {
    const claims = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/) : [];
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return {
      accountId: text(object(claims["https://api.openai.com/auth"]).chatgpt_account_id),
      openAIDirect: scopes.includes("chatgpt.tokens.use.direct") || audiences.includes("https://api.openai.com/v1"),
    };
  } catch { return {}; } // Opaque tokens are valid too.
}
/** Offline auth kind check. Never resolves secrets or refreshes OAuth. */
export function isApiAccount(ctx: ExtensionContext, account: Account): boolean {
  if (account.tokenEnv) return true;
  if (account.request && !account.request.usePiAuth) return false;
  const status = ctx.modelRegistry.getProviderAuthStatus(account.provider);
  if (!status.configured) return false;
  // Respect the active source: a dormant stored OAuth login must not override
  // an environment/config key currently selected by Pi.
  if (status.source !== "stored")
    return ["environment", "models_json_key", "models_json_command"].includes(status.source ?? "");
  try { return readStoredCredential(account.provider)?.type === "api_key"; }
  catch { return false; }
}
export async function resolveAuth(ctx: ExtensionContext, provider: string, tokenEnv?: string): Promise<QueryAuth> {
  if (tokenEnv) {
    const token = process.env[tokenEnv];
    if (!token) throw new UsageError("missing-auth", `请设置环境变量 ${tokenEnv}。`);
    const metadata = openAIMetadata(token);
    return { token, oauth: Boolean(metadata.openAIDirect || metadata.accountId || token.startsWith("sk-ant-oat")), ...metadata };
  }
  let resolved;
  try { resolved = await ctx.modelRegistry.getProviderAuth(provider); }
  catch { throw new UsageError("missing-auth", "Pi 认证解析或刷新失败，请重新 /login 对应提供商。"); }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved?.auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }
  const bearer = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  let token = resolved?.auth.apiKey || bearer?.replace(/^Bearer\s+/i, "") || "";
  const oauth = resolved?.source === "OAuth";
  // Copilot inference uses a short-lived Copilot token. The usage API requires
  // the original GitHub token, stored by Pi as the OAuth refresh credential.
  if (provider === "github-copilot" && oauth) {
    const stored = readStoredCredential(provider);
    if (stored?.type === "oauth") {
      if (text(stored.enterpriseUrl))
        throw new UsageError("unsupported", "Copilot Enterprise 自定义域名请使用 HTTP 自定义查询配置。");
      token = stored.refresh;
    }
  }
  if (!token) throw new UsageError("missing-auth", `未找到 ${provider} 的可用凭据，请先 /login 或配置 tokenEnv。`);
  return { token, oauth, ...openAIMetadata(token),
    // Current Pi's openai OAuth flow is the direct API grant. This fallback
    // also covers opaque access tokens without inspecting stored credentials.
    ...(provider === "openai" && oauth ? { openAIDirect: true } : {}),
  };
}
