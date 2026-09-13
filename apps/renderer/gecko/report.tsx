import { BugReportPage } from '../src/components/BugReportPage';
import { bridge } from '../src/lib/bridge';
import { readReportQuery } from '../src/lib/reportPage';
import { mount } from './mount';
import { openPage, openTab } from './navigation';

/** The browser closes this page's tab; a plain browser tab can only try. */
function closeReport() {
  const toji = bridge();
  if (toji.closeReport) toji.closeReport();
  else window.close();
}

/**
 * about:report?page=…&window=…&layout=…&theme=… — Help › Report a Bug…, opened by the
 * browser in a tab of the window being reported on, with that window's facts in the query.
 */
const request = readReportQuery(document.documentURI || window.location.href);

mount(<BugReportPage request={request} onOpenUrl={openTab} onOpenSettings={() => openPage('settings')} onClose={closeReport} />);
