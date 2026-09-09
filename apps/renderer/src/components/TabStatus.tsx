import { MousePointer2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserTab } from '../types';

const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

/**
 * A tab's leading slot: the site's favicon (or its group colour), with a spinner while
 * the page loads. The favicon is how a tab is recognised at a glance, so nothing else
 * ever takes its place — status marks go at the trailing end (see TabAgentCursor).
 *
 * Shared by both tab strips so the top and side layouts can never drift apart.
 */
export function TabStatus({ tab, color }: { tab: BrowserTab; color?: string | null }) {
  if (tab.status === 'loading') {
    return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" title="Loading" />;
  }
  if (color) return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
  return <TabFavicon tab={tab} />;
}

/**
 * The mark for a tab the agent is driving: the same cursor as the agent's spotlight, so
 * "this tab is being driven" reads identically wherever it appears. It sits just before
 * the close button, leaving the favicon untouched; the title truncates to make room.
 */
export function TabAgentCursor() {
  return (
    <span
      data-testid="tab-agent-cursor"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-neutral-900 dark:text-neutral-100"
      title="The agent is working on this tab"
    >
      <MousePointer2 size={13} className="agent-tab-cursor" />
    </span>
  );
}

function TabFavicon({ tab }: { tab: BrowserTab }) {
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [tab.favicon]);
  if (tab.mode === 'web' && tab.favicon && !errored) {
    return <img src={tab.favicon} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[4px]" onError={() => setErrored(true)} />;
  }
  return <img src={ICON} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[5px]" />;
}
