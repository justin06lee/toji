// One shape for every form control, so controls sharing a row line up exactly.
//
// Before this, each field carried its own ad-hoc padding and text size, and the same
// row could hold a 31px input beside a 37px dropdown beside a 34px button. Heights are
// set explicitly (h-9) rather than left to padding + line-height, because those two
// only agree while the font size does.

/** Shared box: border, radius, background, focus treatment. */
const BOX =
  'rounded-lg border border-black/10 bg-transparent outline-none transition focus:border-black/30 dark:border-white/12 dark:focus:border-white/30';

/** The control height every field-row element shares (h-9 = 36px). */
export const FIELD_HEIGHT = 'h-9';

/** Single-line text input, and anything that must look like one. */
export const FIELD = `w-full ${FIELD_HEIGHT} ${BOX} px-2.5 text-[13px] placeholder:text-neutral-400`;

/** Monospace variant for keys, URLs, and generated values. Same box, same height. */
export const FIELD_MONO = `${FIELD} font-mono text-[12px]`;

/** Multi-line: identical box and padding, but height comes from the row count. */
export const FIELD_TEXTAREA = `w-full resize-y ${BOX} px-2.5 py-2 text-[13px] placeholder:text-neutral-400`;

/** Filled action button sized to sit beside a field (Save, Add). */
export const FIELD_BUTTON =
  `inline-flex ${FIELD_HEIGHT} shrink-0 items-center justify-center gap-1.5 rounded-lg bg-neutral-900 px-3 text-[13px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-35 dark:bg-white dark:text-neutral-900`;

/** Bordered action button sized to sit beside a field. */
export const FIELD_BUTTON_QUIET =
  `inline-flex ${FIELD_HEIGHT} shrink-0 items-center justify-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12.5px] transition enabled:hover:border-black/30 disabled:opacity-40 dark:border-white/12 dark:enabled:hover:border-white/30`;
