// Type surface for video-controls.cjs.

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PipController {
  button: HTMLButtonElement | null;
  /** Feed a pointer position in viewport coordinates. */
  pointer(x: number, y: number): void;
  stop(): void;
}

export declare function isWatchable(video: HTMLVideoElement): boolean;
export declare function cornerZone(rect: Rect): { left: number; right: number; top: number; bottom: number };
export declare function videoAtCorner(doc: Document, point: { x: number; y: number }): HTMLVideoElement | null;
export declare function buttonPosition(rect: Rect): { left: number; top: number };
export declare function installPipButton(doc: Document, options?: { setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout }): PipController;
export declare function createSpaceToggle(doc: Document): (event: KeyboardEvent) => boolean;
export declare function installSpaceToggle(doc: Document): () => void;
export declare const BUTTON_SIZE: number;
export declare const BUTTON_INSET: number;
export declare const LINGER_MS: number;
