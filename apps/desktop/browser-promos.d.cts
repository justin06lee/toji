/** True for the pages whose switch-browser promos are removed: the Chrome Web Store and the search engines. */
export function isWatchedHost(href: string): boolean;

/** Every switch-browser promo in or enclosing `root`, outermost first. */
export function findBrowserPromos(root: Node): HTMLElement[];

/** Remove every promo in or enclosing `root`; returns how many went. */
export function removeBrowserPromos(root: Node): number;

/** Remove every promo as it lands; returns a function that stops watching. */
export function watchBrowserPromos(doc: Document): () => void;
