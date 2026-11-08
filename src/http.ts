import { UsageError } from "./types.ts";

const MAX_BYTES = 1024 * 1024;

// Never surface URLs, response bodies, or raw fetch errors: they can contain credentials.
export async function requestJson(url: string, init: RequestInit, signal: AbortSignal, allowHttp = false): Promise<unknown> {
  let target: URL;
  try { target = new URL(url); } catch { throw new UsageError("error", "查询 URL 无效。"); }
  if (target.username || target.password || target.hash ||
      (target.protocol !== "https:" && !(allowHttp && target.protocol === "http:")))
    throw new UsageError("error", "查询地址必须使用 HTTPS 且不能包含用户名、密码或片段；HTTP 需显式 allowHttp。");
  try {
    const response = await fetch(target, { ...init, signal, redirect: "error", cache: "no-store" });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 || response.status === 403
        ? "查询接口拒绝此凭据；可能是令牌类型、受众或查询权限不匹配，不代表 Pi 的模型登录已失效。"
        : response.status === 429 ? "查询被限流，请稍后再试。"
        : "查询接口不可用，可能已变更。";
      throw new UsageError("error", `HTTP ${response.status}：${hint}`);
    }
    if (!response.body) throw new UsageError("error", "查询接口返回空响应。");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new UsageError("error", "查询响应超过 1 MiB，已停止读取。");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new UsageError("error", "查询接口未返回有效 JSON（可能是登录页面或接口已变更）。"); }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("error", signal.aborted ? "查询超时或已取消。" : "网络查询失败（请检查网络、TLS、代理或接口重定向）。");
  }
}
