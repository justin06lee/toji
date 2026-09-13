import { describe, expect, it } from 'vitest';
import { queryParam } from './pageQuery';

describe('queryParam', () => {
  it('reads a parameter from an about: URL', () => {
    expect(queryParam('about:plans?q=best%20laptop%20for%20rust', 'q')).toBe('best laptop for rust');
    expect(queryParam('about:plans?from=settings&q=a+b', 'q')).toBe('a b');
  });

  it('stops at the fragment', () => {
    expect(queryParam('about:plans?q=tea#byo', 'q')).toBe('tea');
  });

  it('is null when there is no query or no such parameter', () => {
    expect(queryParam('about:plans', 'q')).toBeNull();
    expect(queryParam('about:plans#q=tea', 'q')).toBeNull();
    expect(queryParam('chrome://toji/content/pages/plans.html?x=1', 'q')).toBeNull();
  });
});
