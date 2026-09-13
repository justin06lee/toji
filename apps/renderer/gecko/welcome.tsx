import { PageFrame, WelcomeView } from '../src/components/InternalPage';
import { bridge } from '../src/lib/bridge';
import { useContainerStore, useWindowContainer } from '../src/lib/containerSync';
import { mount } from './mount';
import { openTab } from './navigation';

/** "Start browsing": the browser remembers onboarding is done and turns this tab into a new tab page. */
function finishOnboarding() {
  const toji = bridge();
  if (toji.finishOnboarding) toji.finishOnboarding();
  else window.location.assign('./start.html');
}

/** about:welcome — onboarding, as in the Electron app's first tab. */
function WelcomePage() {
  const { containers, setContainers } = useContainerStore();
  const containerId = useWindowContainer();
  return (
    <PageFrame>
      <WelcomeView onOpenUrl={openTab} onGetStarted={finishOnboarding} containers={containers ?? []} onContainersChange={setContainers} containerId={containerId} />
    </PageFrame>
  );
}

mount(<WelcomePage />);
