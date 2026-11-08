import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isApiAccount, resolveAuth } from "./auth.ts";
import { BUILTINS, queryBuiltin, unsupported } from "./providers.ts";
import { queryCustom } from "./custom.ts";
import { UsageError, type Result } from "./types.ts";
import type { Account, Config } from "./config.ts";

export function accountsFor(config: Config, ctx: ExtensionContext): Account[] {
  const configuredProviders = new Set(config.accounts.map(a => a.provider));
  const configuredIds = new Set(config.accounts.map(a => a.id));
  const providers = new Set([
    ...ctx.modelRegistry.getAll().map(m => m.provider),
    ...ctx.modelRegistry.getRegisteredProviderIds(),
    ...(ctx.model ? [ctx.model.provider] : []),
  ]);
  const automatic: Account[] = [];
  for (const provider of providers) {
    if (configuredProviders.has(provider) || config.disabledProviders.includes(provider) || configuredIds.has(provider)) continue;
    if (ctx.modelRegistry.getProviderAuthStatus(provider).configured)
      automatic.push({ id: provider, provider, name: BUILTINS[provider]?.name ?? provider });
  }
  return [...automatic, ...config.accounts.filter(a => a.enabled !== false)];
}

export function selectAccounts(config: Config, ctx: ExtensionContext, target?: string): Account[] {
  const accounts = accountsFor(config, ctx);
  if (target === "all") return accounts;
  const provider = target || ctx.model?.provider;
  if (!provider) return [];
  // Current-model queries must not pick an unrelated provider just because
  // a custom account happens to have the same ID as the current provider.
  const matching = target ? accounts : accounts.filter(a => a.provider === provider);
  const exact = matching.filter(a => a.id === provider);
  const selected = exact.length ? exact : matching.filter(a => a.provider === provider);
  if (selected.length) return selected;
  if (config.disabledProviders.includes(provider) || config.accounts.some(a => a.provider === provider || a.id === provider)) return [];
  // Explain missing auth or unsupported queries rather than silently omitting them.
  return [{ id: provider, provider }];
}

export async function queryAccount(account: Account, config: Config, ctx: ExtensionContext, shutdown: AbortSignal): Promise<Result> {
  const result = {
    id: account.id,
    provider: account.provider,
    name: account.name ?? BUILTINS[account.adapter ?? account.provider]?.name ?? account.id,
    auth: undefined as Result["auth"],
  };
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(config.timeoutMs)]);
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new UsageError("error", "查询超时或已取消。"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const query = async () => {
      if (!account.request && !BUILTINS[account.adapter ?? account.provider]) return unsupported(account.adapter ?? account.provider);
      const auth = !account.request || account.request.usePiAuth || account.tokenEnv
        ? await resolveAuth(ctx, account.provider, account.tokenEnv) : undefined;
      signal.throwIfAborted();
      if (auth) result.auth = auth.oauth ? "oauth" : "api";
      return account.request ? queryCustom(account, auth, signal) : queryBuiltin(account, auth!, signal);
    };
    const snapshot = await Promise.race([query(), cancelled]);
    return { ...result, status: "ok", snapshot, checkedAt: new Date().toISOString() };
  } catch (error) {
    // Offline fallback only; never refresh auth a second time after a failure.
    if (!result.auth && isApiAccount(ctx, account)) result.auth = "api";
    return { ...result, status: error instanceof UsageError ? error.status : "error",
      message: error instanceof UsageError ? error.message : "查询失败；请检查配置与认证（为保护凭据，不显示原始异常）。",
      checkedAt: new Date().toISOString() };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function queryAccounts(accounts: Account[], config: Config, ctx: ExtensionContext, signal: AbortSignal): Promise<Result[]> {
  const results: Result[] = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length && !signal.aborted) {
      const index = next++;
      results[index] = await queryAccount(accounts[index], config, ctx, signal);
    }
  }));
  return results.filter(Boolean);
}
