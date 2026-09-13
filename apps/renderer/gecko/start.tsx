import { LandingSearch } from '../src/components/LandingSearch';
import { mount } from './mount';
import { askAI, navigate } from './navigation';

/**
 * about:start, the new tab page: Toji's landing search box. Enter hands what was typed
 * to the browser; Shift+Enter or the wand asks for an AI page. There is no Tor hold on
 * the Go button here — in the browser, Tor is a container, not a per-tab switch.
 */
function StartPage() {
  return (
    <div className="flex h-full w-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <LandingSearch onGo={navigate} onAi={askAI()} />
    </div>
  );
}

mount(<StartPage />);
