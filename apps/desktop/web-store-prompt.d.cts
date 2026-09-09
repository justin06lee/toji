/** True only for the Chrome Web Store itself, at its current or pre-2024 address. */
export function isChromeWebStore(href: string): boolean;

/** Is this element the store's "Switch to Chrome?" card? */
export function isSwitchToChromePrompt(el: unknown): boolean;

/** Every "Switch to Chrome?" card in or enclosing `root`. */
export function findSwitchToChromePrompts(root: Node): HTMLElement[];

/** Remove every card in or enclosing `root`; returns how many went. */
export function removeSwitchToChromePrompts(root: Node): number;

/** Remove every card as it lands; returns a function that stops watching. */
export function watchSwitchToChromePrompt(doc: Document): () => void;
