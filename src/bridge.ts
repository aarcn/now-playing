import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

// The Even docs warn that overlapping bridge calls (render + storage) can drop
// the glasses connection, so every bridge call goes through one queue.
let bridge: EvenAppBridge | null = null
let tail: Promise<unknown> = Promise.resolve()

export function serial<T>(fn: (b: EvenAppBridge) => Promise<T>): Promise<T> {
  const run = tail.then(() => fn(bridge!))
  tail = run.catch(() => {})
  return run
}

/** Resolves to the bridge inside the Even app, or null in a normal browser. */
export async function connectBridge(timeoutMs = 2000): Promise<EvenAppBridge | null> {
  const timeout = new Promise<null>(r => setTimeout(() => r(null), timeoutMs))
  bridge = await Promise.race([waitForEvenAppBridge(), timeout])
  return bridge
}

export const hasBridge = () => bridge !== null

// Key-value storage: the Even app's store when on the glasses, localStorage otherwise.
export const store = {
  async get(key: string): Promise<string | null> {
    if (!bridge) return localStorage.getItem(key)
    return (await serial(b => b.getLocalStorage(key))) || null
  },
  async set(key: string, value: string): Promise<void> {
    if (!bridge) return localStorage.setItem(key, value)
    await serial(b => b.setLocalStorage(key, value))
  },
  async remove(key: string): Promise<void> {
    if (!bridge) return localStorage.removeItem(key)
    await serial(b => b.setLocalStorage(key, ''))
  },
}
