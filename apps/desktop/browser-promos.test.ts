// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { findBrowserPromos, isWatchedHost, removeBrowserPromos, watchBrowserPromos } from './browser-promos.cjs';

// --- the promos, as the sites render them (September 2026), trimmed to structure ---------

/** Chrome Web Store: a dialog in the header; "Yes" is a div wrapping a download link. */
const storeCard = (heading = 'Switch to Chrome?') => `
  <div class="F7ptP" jsname="v621tc" role="dialog" aria-labelledby="promo-header" style="position: absolute">
    <aside>
      <div><img alt="" src="https://www.gstatic.com/images/branding/productlogos/chrome/v7/192px.svg"><h2 id="promo-header">${heading}</h2></div>
      <p>Google recommends using Chrome when using extensions and themes.</p>
      <div>
        <div><button class="mUIrbf-LgbsSe" jsname="gQ2Xie"><span>No thanks</span></button></div>
        <div><div class="mUIrbf-LgbsSe" jsname="hRZeKc"><span aria-hidden="true">Yes</span><a jsname="hSRGPd" href="https://www.google.com/chrome/?brand=GGRF&amp;utm_medium=material-callout" aria-label="Yes"></a></div></div>
      </div>
    </aside>
  </div>`;

/** DuckDuckGo: an absolutely positioned popover over the results, labelled by data-testid. */
const duckPopover = `
  <div class="vSP7cQ9d56toeDiIRVcQ" data-testid="serp-popover-promo" style="top: 67px; right: 17px;">
    <div class="O9Ipab51rBntYb0pwOQn"><div>
      <header><img alt="" src="data:,"><p><span>Upgrade to our browser.</span></p><button data-testid="serp-popover-promo-close" aria-label="Close"></button></header>
      <img alt="" src="data:,"><h2>Get the free DuckDuckGo Browser to block ads on YouTube.</h2>
      <a data-testid="serp-popover-promo-cta" href="https://duckduckgo.com/mac?origin=funnel_browser_searchresults_adblockingb_popover">Download Browser</a>
    </div></div>
  </div>`;

/** Google's homepage: a fixed card in the corner with no label at all. */
const googleCard = `
  <div id="gws-output-pages-elements-homepage_additional_languages__als" style="position: fixed; bottom: 0; left: 0;">
    <div><img alt="" src="data:,"><div>Chrome — a faster, safer way to browse</div>
      <a href="https://www.google.com/chrome/?brand=CHBD&amp;utm_source=google.com">Download Chrome</a>
      <button>No thanks</button></div>
  </div>`;

/** Bing: a banner in normal flow, labelled by its class. */
const bingBanner = `
  <div class="b_edgePromo b_notificationContainer">
    <span>Switch to Microsoft Edge for a faster, safer experience.</span>
    <a href="https://www.microsoft.com/edge?form=MA13FJ">Get Microsoft Edge</a>
    <button aria-label="Dismiss">✕</button>
  </div>`;

/** A dialog the store shows for its own reasons; it must be left alone. */
const installDialog = `
  <div role="dialog" aria-labelledby="install-title">
    <h2 id="install-title">Add “uBlock Origin”?</h2>
    <p>It can read and change all your data on all websites.</p>
    <button>Cancel</button><button>Add extension</button>
  </div>`;

/** A search result that links to Chrome's download page: content, not a promo. */
const chromeResult = `
  <div class="result">
    <a href="https://www.google.com/chrome/">Google Chrome - Download the fast, secure browser</a>
    <p>Get more done with the new Google Chrome. A more simple, secure and faster web browser than ever.</p>
  </div>`;

/** A floating site header that carries a promo: the header is furniture and stays. */
const stickyHeader = `
  <header style="position: sticky; top: 0">
    <a href="/">Home</a>
    <form role="search"><input type="search" name="q"></form>
    <div class="promo-strip"><span>Try the Brave browser</span><a href="https://brave.com/download/">Download</a></div>
  </header>`;

const el = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const mount = (html: string, parent: ParentNode = document.body) => {
  const node = el(html);
  parent.append(node);
  return node;
};
/** Lets queued mutation-observer callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isWatchedHost', () => {
  test('the store, the search engines Toji offers, and Google in every country', () => {
    for (const url of [
      'https://chromewebstore.google.com/detail/x/abc',
      'https://chrome.google.com/webstore/',
      'https://duckduckgo.com/?q=toji',
      'https://start.duckduckgo.com/',
      'https://www.google.com/search?q=toji',
      'https://www.google.co.uk/',
      'https://google.de/search?q=x',
      'https://www.bing.com/search?q=toji',
      'https://search.brave.com/search?q=toji',
      'https://www.startpage.com/sp/search',
      'https://www.ecosia.org/search?q=toji'
    ]) {
      expect(isWatchedHost(url), url).toBe(true);
    }
  });

  test('nothing else, nothing insecure, nothing that only resembles them', () => {
    for (const url of ['https://example.com/', 'https://duckduckgo.com.evil.example/', 'https://notgoogle.com/', 'https://googleusercontent.com/', 'http://duckduckgo.com/', 'not a url']) {
      expect(isWatchedHost(url), url).toBe(false);
    }
  });
});

describe('findBrowserPromos', () => {
  test('the store card, DuckDuckGo’s popover, Google’s corner card and Bing’s banner', () => {
    const store = mount(storeCard());
    const duck = mount(duckPopover);
    const google = mount(googleCard);
    const bing = mount(bingBanner);
    expect(findBrowserPromos(document)).toEqual([store, duck, google, bing]);
  });

  test('a localized store card, by its download link', () => {
    const prompt = mount(storeCard('Zu Chrome wechseln?'));
    expect(findBrowserPromos(document)).toEqual([prompt]);
  });

  test('leaves search results, other dialogs and page furniture alone', () => {
    mount(chromeResult);
    mount(installDialog);
    mount('<div role="dialog"><h2>Requires Chrome 120 or newer</h2><button>OK</button></div>');
    const header = mount(stickyHeader);
    const strip = header.querySelector('.promo-strip');
    // The header holds a search form, so only the promo strip inside it is a promo.
    expect(findBrowserPromos(document)).toEqual([strip]);
  });

  test('sees a promo from a node inside it, as when a site fills the shell late', () => {
    const duck = mount(duckPopover);
    expect(findBrowserPromos(duck.querySelector('h2')!.parentElement!)).toEqual([duck]);
  });

  test('a promo big enough to be content is content', () => {
    const big = mount(`<div style="position: fixed">${'<a href="/x">link</a>'.repeat(13)}<a href="https://www.google.com/chrome/">Chrome</a></div>`);
    expect(findBrowserPromos(document)).toEqual([]);
    expect(big.isConnected).toBe(true);
  });
});

describe('removeBrowserPromos', () => {
  test('removes each promo and nothing else, and never follows the link', () => {
    const result = mount(chromeResult);
    const duck = mount(duckPopover);
    const followed = vi.fn((e: Event) => e.preventDefault());
    duck.querySelector('a')!.addEventListener('click', followed);
    expect(removeBrowserPromos(document)).toBe(1);
    expect(duck.isConnected).toBe(false);
    expect(result.isConnected).toBe(true);
    expect(followed).not.toHaveBeenCalled();
  });
});

describe('watchBrowserPromos', () => {
  test('removes a promo that is already there and each one that arrives later', async () => {
    const first = mount(storeCard());
    const stop = watchBrowserPromos(document);
    expect(first.isConnected).toBe(false);

    const second = mount(duckPopover); // client-side navigation re-creates it
    await flush();
    expect(second.isConnected).toBe(false);
    stop();
  });

  test('catches a promo a site mounts empty and fills afterwards', async () => {
    const stop = watchBrowserPromos(document);
    const shell = mount('<div data-testid="serp-popover-promo"></div>');
    await flush();
    expect(shell.isConnected).toBe(true);

    shell.innerHTML = el(duckPopover).innerHTML;
    await flush();
    expect(shell.isConnected).toBe(false);
    stop();
  });

  test('catches a card that only becomes a dialog once its role is set', async () => {
    const stop = watchBrowserPromos(document);
    const prompt = el(storeCard());
    prompt.removeAttribute('role');
    prompt.style.position = 'static';
    document.body.append(prompt);
    await flush();
    expect(prompt.isConnected).toBe(true);

    prompt.setAttribute('role', 'dialog');
    await flush();
    expect(prompt.isConnected).toBe(false);
    stop();
  });

  test('leaves the page’s own dialogs alone, and stops when told to', async () => {
    const stop = watchBrowserPromos(document);
    const install = mount(installDialog);
    await flush();
    expect(install.isConnected).toBe(true);

    stop();
    const late = mount(duckPopover);
    await flush();
    expect(late.isConnected).toBe(true);
  });
});
