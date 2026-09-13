import { PageFrame, SettingsView } from '../src/components/InternalPage';
import { useContainerStore } from '../src/lib/containerSync';
import { mount } from './mount';
import { openPage } from './navigation';

/** about:settings — the same sections as the Electron app's Settings tab. */
function SettingsPage() {
  const { containers, setContainers, clearContainer } = useContainerStore();
  return (
    <PageFrame>
      <SettingsView containers={containers ?? []} onContainersChange={setContainers} onClearContainer={clearContainer} onShowPlans={() => openPage('plans')} />
    </PageFrame>
  );
}

mount(<SettingsPage />);
