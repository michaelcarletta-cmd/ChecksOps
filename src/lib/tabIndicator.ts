import { isNativeApp } from "./nativeApp.ts";

export type TabBox = { x: number; y: number; w: number; h: number };

type ListLike = {
  querySelectorAll: (sel: string) => ArrayLike<unknown>;
  style: { setProperty: (name: string, value: string) => void };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  hasAttribute: (name: string) => boolean;
};

type TabLike = {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
  closest?: (sel: string) => unknown;
};

/** The active tab of this list (not of a tab list nested inside it), as offsets within the list. */
export function measureActiveTab(list: ListLike): TabBox | null {
  const tabs = Array.from(list.querySelectorAll('[role="tab"][data-state="active"]')) as TabLike[];
  const own = tabs.find((t) => typeof t.closest !== "function" || t.closest('[role="tablist"]') === list);
  if (!own || own.offsetWidth === 0 || own.offsetHeight === 0) return null;
  return { x: own.offsetLeft, y: own.offsetTop, w: own.offsetWidth, h: own.offsetHeight };
}

/**
 * Website only: place the sliding highlight (TabsList's [data-tab-indicator]) under the active tab.
 * The CSS shows it, and hides the active tab's own background, only while `data-tab-indicator-ready`
 * is set, so a hidden list (zero size) or the app keeps the plain tab look. Returns whether it shows.
 */
export function syncTabIndicator(
  list: ListLike | null | undefined,
  win: unknown = typeof window === "undefined" ? undefined : window,
): boolean {
  if (!list) return false;
  const box = isNativeApp(win) ? null : measureActiveTab(list);
  if (!box) {
    list.removeAttribute("data-tab-indicator-ready");
    return false;
  }
  list.style.setProperty("--tab-x", `${box.x}px`);
  list.style.setProperty("--tab-y", `${box.y}px`);
  list.style.setProperty("--tab-w", `${box.w}px`);
  list.style.setProperty("--tab-h", `${box.h}px`);
  list.setAttribute("data-tab-indicator-ready", "");
  return true;
}
