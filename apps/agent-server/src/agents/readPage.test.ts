import { afterEach, describe, expect, test, vi } from 'vitest';

// Research reads sources with fetch + Readability, no browser engine. These tests pin
// what the model sees from a page, and that the SSRF guard runs on every redirect hop.

// Hostnames resolve from this table, so no test touches real DNS.
vi.mock('node:dns/promises', () => {
  const table: Record<string, string> = {
    'public.test': '93.184.216.34',
    'redirector.test': '93.184.216.35',
    'intranet.test': '10.0.0.7'
  };
  return {
    lookup: async (host: string) => {
      const address = table[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    }
  };
});

// Readability is real unless a test asks it to find nothing, which is the only way to
// reach the body-text fallback deterministically.
const readability = vi.hoisted(() => ({ findNothing: false }));
vi.mock('@mozilla/readability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mozilla/readability')>();
  class Readability<T> extends actual.Readability<T> {
    parse() {
      return readability.findNothing ? null : super.parse();
    }
  }
  return { ...actual, Readability };
});

const { extractPage, fetchHtml, NotHtmlError } = await import('./readPage.js');

const LONG_PARAGRAPH =
  'Tidal power converts the energy carried by the rise and fall of the sea into electricity. ' +
  'Because tides follow the orbit of the moon they are predictable decades ahead, which makes the output easy to schedule on a grid. ' +
  'The best sites have a large tidal range and a narrow channel that concentrates the flow of water through turbines.';

const ARTICLE_HTML = `<!doctype html>
<html>
<head>
  <title>  Tidal Energy
     Explained </title>
  <meta name="description" content="How the tides make electricity.">
  <base href="https://example.org/docs/">
  <style>.hero { color: red }</style>
  <script>var tracking = 'script text must not leak';</script>
</head>
<body>
  <nav><a href="/home">Home</a> <a href="javascript:void(0)">Menu</a></nav>
  <article>
    <h1>Tidal energy</h1>
    <p>${LONG_PARAGRAPH}</p>
    <h2>How it works</h2><p>${LONG_PARAGRAPH}</p>
    <h3>Barrages</h3><p>A barrage is a dam across an estuary.</p><p>Water is held back at high tide and released through turbines.</p>
    <p>Read <a href="guide.html">the full guide</a>, compare with <a href="https://other.example.com/x">another  source</a>, or <a href="mailto:a@b.c">write to us</a>.</p>
  </article>
  <footer>Copyright footer text</footer>
</body>
</html>`;

describe('extractPage', () => {
  afterEach(() => {
    readability.findNothing = false;
  });

  test('pulls the title, h1–h3 headings and resolved http links', () => {
    const page = extractPage(ARTICLE_HTML, 'https://example.org/docs/tides');
    expect(page.title).toBe('Tidal Energy Explained');
    expect(page.url).toBe('https://example.org/docs/tides');
    expect(page.headings).toEqual(['Tidal energy', 'How it works', 'Barrages']);
    expect(page.links).toEqual([
      { text: 'Home', url: 'https://example.org/home' },
      { text: 'the full guide', url: 'https://example.org/docs/guide.html' },
      { text: 'another source', url: 'https://other.example.com/x' }
    ]);
  });

  test('leads with the meta description, then Readability’s article text', () => {
    const page = extractPage(ARTICLE_HTML, 'https://example.org/docs/tides');
    expect(page.text.startsWith('How the tides make electricity. ')).toBe(true);
    expect(page.text).toContain('Tidal power converts the energy carried by the rise and fall of the sea into electricity.');
    // Block boundaries become spaces rather than gluing words together.
    expect(page.text).toContain('a dam across an estuary. Water is held back');
    expect(page.text).not.toContain('script text must not leak');
    expect(page.text).not.toContain('Copyright footer text');
    expect(page.text).not.toMatch(/\s{2,}/);
  });

  test('falls back to the body minus chrome when Readability finds no article', () => {
    readability.findNothing = true;
    const html = `<html><head><title>Status</title></head><body>
      <nav>Top navigation</nav>
      <div><p>All systems</p><p>operational.</p></div>
      <aside>Sidebar promo</aside><form><label>Search the site</label></form>
      <svg><text>chart label</text></svg><iframe>frame text</iframe><noscript>enable js</noscript>
      <footer>Footer links</footer>
      <script>leak()</script>
    </body></html>`;
    const page = extractPage(html, 'https://status.example.com/');
    expect(page.text).toBe('All systems operational.');
  });

  test('caps headings at 18 and links at 30, link text at 90 characters', () => {
    const headings = Array.from({ length: 25 }, (_, i) => `<h2>Heading ${i}</h2>`).join('');
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/p/${i}">${'x'.repeat(120)}${i}</a>`).join('');
    const page = extractPage(`<html><head><title>t</title></head><body>${headings}${links}</body></html>`, 'https://example.com/');
    expect(page.headings).toHaveLength(18);
    expect(page.links).toHaveLength(30);
    expect(page.links[0].text).toHaveLength(90);
  });

  test('a page with no <title> reports an empty title for the caller to fill in', () => {
    expect(extractPage('<html><body><p>hi</p></body></html>', 'https://example.com/').title).toBe('');
  });
});

describe('fetchHtml', () => {
  const fetchMock = vi.fn<typeof fetch>();

  function stubFetch(routes: Record<string, () => Response>) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route();
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
  const html = (body: string, contentType = 'text/html; charset=utf-8') => () => new Response(body, { status: 200, headers: { 'content-type': contentType } });
  const fetchedUrls = () => fetchMock.mock.calls.map(([input]) => String(input));
  const options = { timeoutMs: 5_000, userAgent: 'TojiTest/1.0' };

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  test('follows public redirects by hand, reporting each hop', async () => {
    stubFetch({
      'http://redirector.test/a': redirect('/b', 301),
      'http://redirector.test/b': redirect('https://public.test/final'),
      'https://public.test/final': html('<html><head><title>Done</title></head><body>ok</body></html>')
    });
    const hops: string[] = [];
    const page = await fetchHtml('http://redirector.test/a', { ...options, onRedirect: (_from, to) => hops.push(to) });
    expect(page.url).toBe('https://public.test/final');
    expect(page.redirects).toBe(2);
    expect(page.html).toContain('<title>Done</title>');
    expect(hops).toEqual(['http://redirector.test/b', 'https://public.test/final']);
    // fetch never follows a redirect on its own; every hop comes back here first.
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('manual');
  });

  test('refuses a redirect hop to a private address before requesting it', async () => {
    stubFetch({ 'https://public.test/start': redirect('http://169.254.169.254/latest/meta-data/') });
    await expect(fetchHtml('https://public.test/start', options)).rejects.toThrow(/private or internal host/);
    expect(fetchedUrls()).toEqual(['https://public.test/start']);
  });

  test('refuses a redirect hop to a public-looking name that resolves internally', async () => {
    stubFetch({ 'https://public.test/start': redirect('http://intranet.test/admin') });
    await expect(fetchHtml('https://public.test/start', options)).rejects.toThrow(/private or internal host: intranet\.test/);
    expect(fetchedUrls()).toEqual(['https://public.test/start']);
  });

  test('refuses a redirect hop to a non-http scheme', async () => {
    stubFetch({ 'https://public.test/start': redirect('file:///etc/passwd') });
    await expect(fetchHtml('https://public.test/start', options)).rejects.toThrow(/non-http\(s\)/);
    expect(fetchedUrls()).toEqual(['https://public.test/start']);
  });

  test('refuses a private starting URL without any request', async () => {
    stubFetch({});
    await expect(fetchHtml('http://127.0.0.1:8788/api/settings', options)).rejects.toThrow(/private or internal host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('gives up after five redirect hops', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i += 1) routes[`https://public.test/${i}`] = redirect(`https://public.test/${i + 1}`);
    stubFetch(routes);
    await expect(fetchHtml('https://public.test/0', options)).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test('skips anything that is not HTML with a typed error', async () => {
    stubFetch({ 'https://public.test/report.pdf': html('%PDF-1.7', 'application/pdf') });
    const error = await fetchHtml('https://public.test/report.pdf', options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotHtmlError);
    expect((error as InstanceType<typeof NotHtmlError>).contentType).toBe('application/pdf');
  });

  test('decodes the charset the response names', async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('<p>caf'), 0xe9, ...new TextEncoder().encode('</p>')]);
    stubFetch({ 'https://public.test/fr': () => new Response(latin1, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }) });
    expect((await fetchHtml('https://public.test/fr', options)).html).toBe('<p>café</p>');
  });

  test('stops reading past the byte cap', async () => {
    stubFetch({ 'https://public.test/big': html(`<p>${'a'.repeat(10_000)}</p>`) });
    const page = await fetchHtml('https://public.test/big', { ...options, maxBytes: 1_000 });
    expect(page.bytes).toBe(1_000);
    expect(page.truncated).toBe(true);
  });
});
