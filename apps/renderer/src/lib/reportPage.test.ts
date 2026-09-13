import { describe, expect, test } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_IMAGES } from './bugReport';
import { acceptImages, CLIPBOARD_NOTICE_MS, formRouteClose, readReportQuery } from './reportPage';

describe('readReportQuery', () => {
  test('fills the page address and the context the browser opened the page with', () => {
    const href = `about:report?page=${encodeURIComponent('https://example.com/a?b=1&c=2')}&window=${encodeURIComponent('1440×900')}&layout=side&theme=dark`;
    expect(readReportQuery(href)).toEqual({ pageUrl: 'https://example.com/a?b=1&c=2', context: { window: '1440×900', layout: 'side', theme: 'dark' } });
  });

  test('an empty page offers no address', () => {
    expect(readReportQuery('about:report?page=&window=800x600&layout=top&theme=light')).toEqual({
      pageUrl: null,
      context: { window: '800×600', layout: 'top', theme: 'light' }
    });
  });

  test('only web pages are offered', () => {
    expect(readReportQuery(`about:report?page=${encodeURIComponent('about:settings')}`).pageUrl).toBeNull();
    expect(readReportQuery(`about:report?page=${encodeURIComponent('file:///Users/me/secret.pdf')}`).pageUrl).toBeNull();
    expect(readReportQuery('about:report?page=not%20a%20url').pageUrl).toBeNull();
  });

  test('missing or malformed context stays blank', () => {
    expect(readReportQuery('about:report').context).toEqual({ window: '', layout: '', theme: '' });
    expect(readReportQuery('about:report?window=huge&layout=diagonal&theme=sepia').context).toEqual({ window: '', layout: '', theme: '' });
  });

  test('stops at the fragment', () => {
    expect(readReportQuery('about:report?theme=dark#layout=side').context).toEqual({ window: '', layout: '', theme: 'dark' });
  });
});

describe('acceptImages', () => {
  const png = (name: string, size = 10) => ({ name, type: 'image/png', size });

  test('takes images while there is room, and says when there is not', () => {
    const { accepted, problem } = acceptImages([png('a'), png('b'), png('c')], MAX_IMAGES - 2);
    expect(accepted.map((f) => f.name)).toEqual(['a', 'b']);
    expect(problem).toMatch(`at most ${MAX_IMAGES}`);
  });

  test('skips what GitHub would refuse and keeps going', () => {
    const { accepted, problem } = acceptImages([{ name: 'notes.pdf', type: 'application/pdf', size: 10 }, png('big', MAX_IMAGE_BYTES + 1), png('ok')], 0);
    expect(accepted.map((f) => f.name)).toEqual(['ok']);
    expect(problem).toMatch(/big is over 10 MB/);
  });

  test('a pasted image without a name is still named in the message', () => {
    expect(acceptImages([{ type: 'image/tiff', size: 10 }], 0).problem).toMatch(/^Pasted image/);
  });
});

describe('formRouteClose', () => {
  test('closes at once, unless the text is waiting on the clipboard', () => {
    expect(formRouteClose({ bodyOnClipboard: false })).toEqual({ notice: null, closeAfterMs: 0 });
    const clipboard = formRouteClose({ bodyOnClipboard: true });
    expect(clipboard.notice).toMatch(/clipboard/);
    expect(clipboard.closeAfterMs).toBe(CLIPBOARD_NOTICE_MS);
  });
});
