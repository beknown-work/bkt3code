/**
 * T3-CUSTOM(expbkt3): Native notification delivery.
 *
 * Wraps the Notification API so callers never touch `window.Notification`
 * directly: it is absent in non-secure contexts, absent under SSR, and throws
 * rather than returning when permission was denied.
 */

export type BrowserNotificationPermission = "unsupported" | "default" | "granted" | "denied";

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission !== "default") return window.Notification.permission;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return window.Notification.permission;
  }
}

export function showBrowserNotification(input: {
  readonly title: string;
  readonly body: string;
  /** Collapses repeats of the same alert into one OS-level entry. */
  readonly tag: string;
  readonly onActivate?: () => void;
}): boolean {
  if (browserNotificationPermission() !== "granted") return false;
  try {
    const notification = new window.Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: "/apple-touch-icon.png",
    });
    notification.addEventListener("click", () => {
      window.focus();
      input.onActivate?.();
      notification.close();
    });
    return true;
  } catch {
    // Chrome throws here when the page is not a secure context, and some
    // platforms throw when notifications are OS-disabled. Neither is fatal.
    return false;
  }
}
