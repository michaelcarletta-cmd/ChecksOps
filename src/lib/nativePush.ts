/**
 * Push notifications in the iOS/Android app (@capacitor/push-notifications, mobile/).
 *
 * Off unless the build lists the platform in VITE_NATIVE_PUSH_PLATFORMS ("ios", "android" or
 * "ios,android"). Each platform is turned on only once it can deliver: iOS needs the Push
 * Notifications capability and the aps-environment entitlement, Android needs Firebase
 * (google-services.json; registering without it crashes the app), and both need the server's
 * push-register-device function. The website never runs any of this (no window.Capacitor).
 *
 * After sign-in: ask permission once, register the phone, send its token to the server, and open
 * the screen a tapped notification points to (only an in-app path such as /checks/123).
 */
import { isNativeApp } from "./nativeApp.ts";

export type PushPlatform = "ios" | "android";

/** The server function that stores this phone's push token for the signed-in user. */
export const PUSH_REGISTER_FUNCTION = "push-register-device";

type Listener = { remove: () => Promise<void> | void };
type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

export interface PushNotificationsPlugin {
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  register(): Promise<void>;
  addListener(event: string, handler: (payload: unknown) => void): Promise<Listener> | Listener;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { PushNotifications?: PushNotificationsPlugin };
}

/** The platforms this build turns push on for, from a comma list such as "ios,android". */
export function enabledPushPlatforms(raw: unknown = import.meta.env?.VITE_NATIVE_PUSH_PLATFORMS): Set<PushPlatform> {
  const out = new Set<PushPlatform>();
  for (const part of String(raw ?? "").split(",")) {
    const p = part.trim().toLowerCase();
    if (p === "ios" || p === "android") out.add(p);
  }
  return out;
}

/**
 * The in-app path a notification opens, from its data.link. Only a same-app path is accepted
 * ("/..." but not "//host" or "/\host"), so a notification can never send the app to another site.
 */
export function safeNotificationLink(data: unknown): string | null {
  const link = (data as { link?: unknown } | null | undefined)?.link;
  if (typeof link !== "string") return null;
  const path = link;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (path.length > 512 || /[\s\u0000-\u001f]/.test(path)) return null;
  return path;
}

export interface StartNativePushOptions {
  registerDevice: (token: string, platform: PushPlatform) => Promise<unknown>;
  openLink: (path: string) => void;
  onError?: (error: unknown) => void;
  win?: unknown;
  enabled?: Set<PushPlatform>;
}

/** Start push for the signed-in user. Resolves to a cleanup that removes the listeners. */
export async function startNativePush(options: StartNativePushOptions): Promise<() => void> {
  const noop = () => {};
  const win = options.win ?? (typeof window === "undefined" ? undefined : window);
  if (!isNativeApp(win)) return noop;
  const cap = (win as { Capacitor?: CapacitorGlobal }).Capacitor;
  const platform = cap?.getPlatform?.();
  if (platform !== "ios" && platform !== "android") return noop;
  if (!(options.enabled ?? enabledPushPlatforms()).has(platform)) return noop;
  const plugin = cap?.Plugins?.PushNotifications;
  if (!plugin) return noop;

  let state = (await plugin.checkPermissions()).receive;
  if (state === "prompt" || state === "prompt-with-rationale") {
    state = (await plugin.requestPermissions()).receive;
  }
  if (state !== "granted") return noop;

  const report = (error: unknown) => options.onError?.(error);
  const listeners = await Promise.all([
    plugin.addListener("registration", (payload) => {
      const token = (payload as { value?: unknown } | null)?.value;
      if (typeof token === "string" && token) {
        Promise.resolve(options.registerDevice(token, platform)).catch(report);
      }
    }),
    plugin.addListener("registrationError", report),
    plugin.addListener("pushNotificationActionPerformed", (payload) => {
      const notification = (payload as { notification?: { data?: unknown } } | null)?.notification;
      const path = safeNotificationLink(notification?.data);
      if (path) options.openLink(path);
    }),
  ]);
  await plugin.register();
  return () => {
    for (const listener of listeners) void listener.remove();
  };
}
