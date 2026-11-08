import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, Text, truncateToWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

/** Bounded viewport over the complete result; never a capped string-array widget. */
export function createDetailsViewer(
  lines: string[],
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: () => void,
): Component {
  const body = new Text(lines.join("\n"), 0, 0);
  const scroll = new ScrollView(body, { follow: "none", scrollbar: "hidden" });
  let height = 1;
  return {
    render(width) {
      const columns = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows);
      const footerRows = Math.min(2, rows - 1);
      height = Math.max(1, Math.min(30, rows - 8, rows - footerRows));
      // Text wraps at the current width, including CJK characters and long URLs.
      // ScrollView owns offset/clamping; layout is explicit for this inline screen.
      const wrapped = scroll.render(columns);
      const totalLines = wrapped.length;
      scroll.updateLayout(totalLines, height, () => tui.requestRender());
      const page = wrapped.slice(scroll.scrollTop, scroll.scrollTop + height);
      const from = totalLines ? scroll.scrollTop + 1 : 0;
      const to = Math.min(totalLines, scroll.scrollTop + height);
      if (footerRows > 0) page.push(theme.fg("dim", `${from}–${to} / ${totalLines} 行`));
      if (footerRows > 1) page.push(theme.fg("muted", "↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End 首尾 · Enter/Esc 关闭"));
      return page.map(line => truncateToWidth(line, columns));
    },
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) { done(); return; }
      if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
      else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
      else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-height);
      else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(height);
      else if (matchesKey(data, "home")) scroll.scrollToStart();
      else if (matchesKey(data, "end")) scroll.scrollToEnd();
      else return;
      tui.requestRender();
    },
    invalidate() { body.invalidate(); },
  };
}

export async function showDetails(ctx: ExtensionContext, lines: string[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    else process.stderr.write(lines.join("\n") + "\n");
    return;
  }
  ctx.ui.setWidget("pi-usage", undefined);
  let onAbort: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      onAbort = () => done();
      signal.addEventListener("abort", onAbort, { once: true });
      // Deferring completion avoids resolving a custom UI before Pi installs it.
      if (signal.aborted) queueMicrotask(onAbort);
      return createDetailsViewer(lines, tui, theme, keybindings, () => done());
    });
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
