// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  findSwitchToChromePrompts,
  isChromeWebStore,
  removeSwitchToChromePrompts,
  watchSwitchToChromePrompt
} from './web-store-prompt.cjs';

/**
 * The card as the store renders it (September 2026), trimmed to structure. Classes and
 * jsnames are the minified ones seen live; "Yes" is not a button but a div wrapping a link.
 */
const card = (heading = 'Switch to Chrome?') => `
  <div class="F7ptP" jsname="v621tc" role="dialog" aria-labelledby="promo-header">
    <aside>
      <div><img alt="" src="https://www.gstatic.com/images/branding/productlogos/chrome/v7/192px.svg"><h2 id="promo-header">${heading}</h2></div>
      <p>Google recommends using Chrome when using extensions and themes.</p>
      <div>
        <div><button class="mUIrbf-LgbsSe" jsname="gQ2Xie"><span>No thanks</span></button></div>
        <div>
          <div class="mUIrbf-LgbsSe" jsname="hRZeKc">
            <span aria-hidden="true">Yes</span>
            <a jsname="hSRGPd" href="https://www.google.com/chrome/?brand=GGRF&amp;utm_medium=material-callout" aria-label="Yes"></a>
          </div>
        </div>
      </div>
    </aside>
  </div>`;

/** A dialog the store shows for its own reasons; it must be left alone. */
const installDialog = `
  <div role="dialog" aria-labelledby="install-title">
    <h2 id="install-title">Add “uBlock Origin”?</h2>
    <p>It can read and change all your data on all websites.</p>
    <button>Cancel</button><button>Add extension</button>
  </div>`;

const el = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const mount = (html: string) => {
  const node = el(html);
  document.body.append(node);
  return node;
};
/** Lets queued mutation-observer callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isChromeWebStore', () => {
  test('the store, at either of its addresses', () => {
    expect(isChromeWebStore('https://chromewebstore.google.com/')).toBe(true);
    expect(isChromeWebStore('https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm')).toBe(true);
    expect(isChromeWebStore('https://chrome.google.com/webstore/category/extensions')).toBe(true);
  });

  test('nothing that merely resembles or mentions it', () => {
    expect(isChromeWebStore('https://chrome.google.com/')).toBe(false);
    expect(isChromeWebStore('https://chromewebstore.google.com.example.net/')).toBe(false);
    expect(isChromeWebStore('https://example.com/?from=chromewebstore.google.com')).toBe(false);
    expect(isChromeWebStore('http://chromewebstore.google.com/')).toBe(false);
    expect(isChromeWebStore('not a url')).toBe(false);
  });
});

describe('findSwitchToChromePrompts', () => {
  test('finds the card among the page’s other dialogs', () => {
    mount(installDialog);
    const prompt = mount(card());
    expect(findSwitchToChromePrompts(document)).toEqual([prompt]);
  });

  test('recognises a localized card by its download link', () => {
    const prompt = mount(card('Zu Chrome wechseln?'));
    expect(findSwitchToChromePrompts(document)).toEqual([prompt]);
  });

  test('ignores a dialog that only mentions Chrome', () => {
    mount('<div role="dialog"><h2>Requires Chrome 120 or newer</h2><button>OK</button></div>');
    mount(installDialog);
    expect(findSwitchToChromePrompts(document)).toEqual([]);
  });

  test('sees the card from a node inside it, as when the store fills the shell late', () => {
    const prompt = mount(card());
    expect(findSwitchToChromePrompts(prompt.querySelector('button')!)).toEqual([prompt]);
  });
});

describe('removeSwitchToChromePrompts', () => {
  test('removes the card and nothing else, without following its link', () => {
    const install = mount(installDialog);
    const prompt = mount(card());
    const followed = vi.fn((e: Event) => e.preventDefault());
    prompt.querySelector('a')!.addEventListener('click', followed);

    expect(removeSwitchToChromePrompts(document)).toBe(1);
    expect(prompt.isConnected).toBe(false);
    expect(install.isConnected).toBe(true);
    expect(followed).not.toHaveBeenCalled();
  });

  test('is a no-op on a page without the card', () => {
    const install = mount(installDialog);
    expect(removeSwitchToChromePrompts(document)).toBe(0);
    expect(install.isConnected).toBe(true);
  });
});

describe('watchSwitchToChromePrompt', () => {
  test('removes a card that is already there and each one that arrives later', async () => {
    const first = mount(card());
    const stop = watchSwitchToChromePrompt(document);
    expect(first.isConnected).toBe(false);

    const second = mount(card()); // client-side navigation re-creates it
    await flush();
    expect(second.isConnected).toBe(false);
    stop();
  });

  test('catches a card the store mounts empty and fills afterwards', async () => {
    const stop = watchSwitchToChromePrompt(document);
    const shell = mount('<div role="dialog" aria-labelledby="promo-header"></div>');
    await flush();
    expect(shell.isConnected).toBe(true);

    shell.innerHTML = el(card()).innerHTML;
    await flush();
    expect(shell.isConnected).toBe(false);
    stop();
  });

  test('catches a card that only becomes a dialog once its role is set', async () => {
    const stop = watchSwitchToChromePrompt(document);
    const prompt = el(card());
    prompt.removeAttribute('role');
    document.body.append(prompt);
    await flush();
    expect(prompt.isConnected).toBe(true);

    prompt.setAttribute('role', 'dialog');
    await flush();
    expect(prompt.isConnected).toBe(false);
    stop();
  });

  test('leaves the store’s other dialogs alone, and stops when told to', async () => {
    const stop = watchSwitchToChromePrompt(document);
    const install = mount(installDialog);
    await flush();
    expect(install.isConnected).toBe(true);

    stop();
    const late = mount(card());
    await flush();
    expect(late.isConnected).toBe(true);
  });
});
