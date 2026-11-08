import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { queryAccounts, selectAccounts } from "./service.ts";
import { renderFooter } from "./render.ts";

const STATUS_KEY = "pi-usage";
const MIN_REFRESH_MS = 60_000;

/** Session-local, event-driven footer. No timers or persistent account data. */
export class UsageStatus {
  enabled = false;
  private generation = 0;
  private pending?: AbortController;
  private lastAttempt = 0;
  private modelKey = "";

  stop(ctx: ExtensionContext): void {
    this.enabled = false;
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    this.lastAttempt = 0;
    this.modelKey = "";
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  setEnabled(ctx: ExtensionContext, enabled: boolean): void {
    if (!enabled) { this.stop(ctx); return; }
    this.enabled = true;
    void this.refresh(ctx, true);
  }

  async refresh(ctx: ExtensionContext, force = false): Promise<void> {
    if (!this.enabled || !ctx.hasUI) return;
    const model = ctx.model;
    const key = model ? `${model.provider}/${model.id}` : "";
    if (!force && key === this.modelKey && (this.pending || Date.now() - this.lastAttempt < MIN_REFRESH_MS)) return;

    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const run = ++this.generation;
    this.modelKey = key;
    this.lastAttempt = Date.now();
    const current = () => this.enabled && run === this.generation && !controller.signal.aborted;
    const show = (message: string) => {
      if (current()) ctx.ui.setStatus(STATUS_KEY, message);
    };
    try {
      show(model ? "余额查询中…" : "请先选择模型");
      if (!model) return;
      const config = await loadConfig();
      if (!current()) return;
      // The footer shows exactly one login/account: the first match for the
      // current provider. Use /usage query for all linked accounts.
      const account = selectAccounts(config, ctx)[0];
      if (!account) { show("查询账户已禁用或未配置"); return; }
      const [result] = await queryAccounts([account], config, ctx, controller.signal);
      if (result) show(renderFooter(result));
    } catch {
      // Raw exceptions may contain credentials. Details remain in the explicit query command.
      show("配置或查询失败 · /usage query 查看");
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }
}
