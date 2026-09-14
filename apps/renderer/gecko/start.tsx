import { useEffect, useState } from 'react';
import { LandingSearch } from '../src/components/LandingSearch';
import { bridge } from '../src/lib/bridge';
import { mount } from './mount';
import { askAI, navigate } from './navigation';

/**
 * about:start, the new tab page: Toji's landing search box. Enter hands what was typed
 * to the browser; Shift+Enter or the wand asks for an AI page; holding the Go button
 * moves the window to Tor (or back), as the Electron app's did.
 */
function StartPage() {
  const [tor, setTor] = useState<{ active: boolean; canToggle: boolean } | null>(null);
  useEffect(() => {
    void bridge().torMode?.().then(setTor, () => {});
  }, []);
  return (
    <div className="flex h-full w-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <LandingSearch
        onGo={navigate}
        onAi={askAI()}
        tor={tor ? { active: tor.active, onToggle: tor.canToggle ? () => void bridge().toggleTor?.() : undefined } : undefined}
        autoFocus={false}
      />
    </div>
  );
}

mount(<StartPage />);
