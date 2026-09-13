import { PageFrame, PlansView } from '../src/components/InternalPage';
import { queryParam } from '../src/lib/pageQuery';
import { mount } from './mount';
import { askAI, openTab } from './navigation';

/**
 * about:plans — and about:plans?q=… when a question sent the user here. "Continue" hands
 * that question back to the browser as an AI page, once a backend has been picked.
 */
function PlansPage() {
  const query = queryParam(document.documentURI || window.location.href, 'q')?.trim() || undefined;
  const ask = askAI();
  return (
    <PageFrame wide>
      <PlansView onOpenUrl={openTab} pendingQuery={query} onContinue={query && ask ? () => ask(query) : undefined} />
    </PageFrame>
  );
}

mount(<PlansPage />);
