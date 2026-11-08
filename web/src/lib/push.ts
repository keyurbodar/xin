import {
  base64ToBytes,
  errorMessage,
  pushKey,
  pushSubscribe,
  pushUnsubscribe,
  subscriptionOf,
} from "../state/settings.ts"

export const SERVICE_WORKER = "/sw.js"

export type PushChange =
  | { readonly kind: "subscribed"; readonly endpoint: string }
  | { readonly kind: "unsubscribed" }
  | { readonly kind: "failed"; readonly message: string }

const NO_PUSH = "This browser cannot receive push notifications."
const NO_HTTPS = "Push needs a secure connection. Open this site over https, or on localhost."

function unsupported(): string | undefined {
  if (typeof window === "undefined" || typeof navigator === "undefined") return NO_PUSH
  if (!window.isSecureContext) return NO_HTTPS
  if (typeof Notification === "undefined") return NO_PUSH
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return NO_PUSH
  return undefined
}

function failed(failure: unknown, fallback: string): PushChange {
  const message = errorMessage(failure)
  return { kind: "failed", message: message === "" ? fallback : message }
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined
  return navigator.serviceWorker.getRegistration(SERVICE_WORKER).catch(() => undefined)
}

async function activeWorker(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active !== null) return
  const worker = registration.installing ?? registration.waiting
  if (worker === null) return
  await new Promise<void>((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      switch (worker.state) {
        case "activated":
          resolve()
          return
        case "redundant":
          reject(new Error("The service worker could not start."))
          return
        default:
          return
      }
    })
  })
}

export async function currentEndpoint(): Promise<string | undefined> {
  const registration = await activeRegistration()
  const subscription = await registration?.pushManager.getSubscription().catch(() => undefined)
  return subscription === undefined || subscription === null ? undefined : subscription.endpoint
}

export async function enablePush(): Promise<PushChange> {
  const blocked = unsupported()
  if (blocked !== undefined) return { kind: "failed", message: blocked }
  try {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
    if (permission === "denied") {
      return {
        kind: "failed",
        message: "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
      }
    }
    if (permission !== "granted") return { kind: "failed", message: "Notifications were not allowed." }

    const registration = await navigator.serviceWorker.register(SERVICE_WORKER)
    await activeWorker(registration)
    const existing = await registration.pushManager.getSubscription()
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(await pushKey()),
      }))
    const found = subscriptionOf(subscription)
    if (found === undefined) return { kind: "failed", message: "The browser returned a subscription without its keys." }
    await pushSubscribe(found.endpoint, found.keys)
    return { kind: "subscribed", endpoint: found.endpoint }
  } catch (failure) {
    return failed(failure, "Push could not be turned on.")
  }
}

export async function disablePush(endpoint: string): Promise<PushChange> {
  try {
    await pushUnsubscribe(endpoint)
    const registration = await activeRegistration()
    const subscription = await registration?.pushManager.getSubscription().catch(() => undefined)
    await subscription?.unsubscribe()
    return { kind: "unsubscribed" }
  } catch (failure) {
    return failed(failure, "Push could not be turned off.")
  }
}
