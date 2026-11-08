import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig } from "./config.ts";
import { accountsFor, queryAccounts, selectAccounts } from "./service.ts";
import { UsageStatus } from "./status.ts";
import { emptyUsage, summarizeSessionUsage } from "./session.ts";
import { BUILTINS } from "./providers.ts";
import { renderResults, safe, withoutParentheses } from "./render.ts";
import { showDetails } from "./details.ts";
import { UsageError } from "./types.ts";

const HELP = [
  "pi-usage",
  "/usage                 开关当前会话的底部余额状态栏",
  "/usage on | off        显式开启 / 关闭状态栏",
  "/usage refresh         立即刷新已开启的状态栏",
  "/usage query           详细查询当前模型对应的账户",
  "/usage all             查询全部已配置账户，最多 4 路并发",
  "/usage <账户ID/提供商>   查询指定账户或提供商",
  "/usage list            列出账户与内置适配器",
  "/usage clear           取消详细查询并清除提示",
  "/usage help            显示帮助和配置文件路径",
  "",
  "状态栏默认关闭，仅当前会话生效；开启/切换模型时查询，回复结束后最短 60 秒刷新。",
  "不发送模型请求、不定时轮询、不持久化查询结果；状态栏不会替换 Pi 默认 footer。",
  "详细结果在可滚动面板中查看；方向键滚动、翻页键翻页、Enter/Esc 关闭。",
  "RPC 通过通知返回完整结果；无 UI 模式输出到 stderr。",
];
function show(ctx: ExtensionContext, lines: string[]): void {
  lines = lines.map(withoutParentheses);
  if (ctx.mode === "tui") ctx.ui.setWidget("pi-usage", lines);
  else if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
  else process.stderr.write(lines.join("\n") + "\n");
}
export default function piUsage(pi: ExtensionAPI): void {
  let active: AbortController | undefined;
  let lifetime = new AbortController();
  const status = new UsageStatus();
  pi.on("session_start", (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController(); active = undefined;
    status.stop(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifetime.abort(); active = undefined;
    status.stop(ctx);
  });
  // Start async queries without delaying model selection or agent event dispatch.
  pi.on("model_select", (_event, ctx) => { void status.refresh(ctx, true); });
  pi.on("agent_settled", (_event, ctx) => { void status.refresh(ctx); });
  pi.registerCommand("usage", {
    description: "开关底部余额状态栏；/usage [on|off|refresh|query|all|账户ID|list|help|clear]",
    getArgumentCompletions: prefix => {
      const items = ["on", "off", "refresh", "query", "all", "list", "help", "clear", ...Object.keys(BUILTINS)];
      return items.filter(item => item.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command || command === "on" || command === "off" || command === "refresh") {
        if (!ctx.hasUI) { show(ctx, ["状态栏需要交互式 UI；无 UI 查询请使用 /usage query。"]); return; }
        if (command === "refresh") {
          if (!status.enabled) ctx.ui.notify("余额状态栏尚未开启，请先输入 /usage。", "info");
          else void status.refresh(ctx, true);
          return;
        }
        const enabled = command === "on" || (!command && !status.enabled);
        status.setEnabled(ctx, enabled);
        ctx.ui.notify(enabled ? "余额状态栏已开启；/usage 可关闭。" : "余额状态栏已关闭。", "info");
        return;
      }
      if (command === "clear") {
        active?.abort(); active = undefined;
        if (ctx.hasUI) ctx.ui.setWidget("pi-usage", undefined);
        return;
      }
      if (active) {
        if (ctx.hasUI) ctx.ui.notify("pi-usage 正在查询，请等待当前查询完成。", "warning");
        return;
      }
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      try {
        if (command === "help") {
          await showDetails(ctx, [...HELP, "", `用户配置：${safe(configPath())}`], signal);
          return;
        }
        const config = await loadConfig();
        if (signal.aborted) return;
        if (command === "list") {
          const accounts = accountsFor(config, ctx);
          await showDetails(ctx, ["pi-usage · 账户", ...accounts.map(a => `  ${safe(a.id)} → ${safe(a.provider)}${a.request ? " · 自定义 HTTP" : BUILTINS[a.adapter ?? a.provider] ? "" : " · 暂无内置查询"}`),
            "", "内置适配器，* 表示实验性或非公开查询接口：",
            ...Object.entries(BUILTINS).map(([id, info]) => `  ${id}${info.experimental ? " *" : ""}`),
            "", `配置文件：${safe(configPath())}`, "多个自定义账户可使用不同 id、相同 provider。"], signal);
          return;
        }
        const selected = selectAccounts(config, ctx, command === "query" ? undefined : command);
        if (!selected.length) {
          show(ctx, ["pi-usage：没有可查询账户。请先 /login、选择模型，或添加用户级配置。", `配置文件：${safe(configPath())}`, "/usage list 查看账户；/usage help 查看帮助。"]);
          return;
        }
        show(ctx, [`pi-usage · 正在查询 ${selected.length} 个账户…`]);
        const results = await queryAccounts(selected, config, ctx, signal);
        if (signal.aborted) return;
        if (results.some(result => result.auth === "api")) {
          const usage = summarizeSessionUsage(ctx.sessionManager.getBranch());
          for (const result of results)
            if (result.auth === "api") result.sessionUsage = usage.get(result.provider) ?? emptyUsage();
        }
        await showDetails(ctx, renderResults(results), signal);
      } catch (error) {
        if (!signal.aborted) show(ctx, [`pi-usage：${safe(error instanceof UsageError ? error.message : "配置读取或查询初始化失败；未显示原始异常以保护凭据。")}`]);
      } finally { if (active === controller) active = undefined; }
    },
  });
}
