// Installing the service worker that was already being built and shipped.
//
// `vite-plugin-pwa` was configured with `injectRegister: null`, which means the
// plugin deliberately does not emit a registration snippet and the application
// is expected to do it. Nothing did. So `sw.js` and the web manifest were built
// into `dist` on every deploy, the browser never installed either, and the
// offline story was a config block with no runtime behind it.
//
// Registered by hand rather than through `virtual:pwa-register`, which pulls in
// `workbox-window` for a flow that is a dozen lines of platform API. The
// project ships two runtime dependencies, React and React DOM, and a wrapper
// around `navigator.serviceWorker.register` is not going to be the third.
//
// The update policy is the important part, and it is deliberate: a new build
// waits. Reloading the page under someone who has a 28 MB inpainting model
// resident in memory and a mask half drawn is the one thing this app must never
// decide on its own.

export interface ServiceWorkerState {
  /** A new build is cached and waiting for permission to take over. */
  needsRefresh: boolean
  /** Everything needed to run without a network is now cached. */
  offlineReady: boolean
}

type Listener = (state: ServiceWorkerState) => void

const state: ServiceWorkerState = { needsRefresh: false, offlineReady: false }
const listeners = new Set<Listener>()
let waiting: ServiceWorker | undefined

const publish = () => {
  for (const listener of listeners) listener({ ...state })
}

/** A worker in `waiting` is a build that is ready and being held back. */
function watch(registration: ServiceWorkerRegistration): void {
  const offer = (worker: ServiceWorker | null) => {
    if (!worker) return
    waiting = worker
    state.needsRefresh = true
    publish()
  }

  if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return
      // With no controller this is the first install, not an update: there is
      // nothing to interrupt and nothing to ask about.
      if (navigator.serviceWorker.controller) offer(installing)
      else {
        state.offlineReady = true
        publish()
      }
    })
  })
}

/**
 * Register the worker, once.
 *
 * Failure is not an error worth showing anyone: a browser with service workers
 * disabled, or a page opened over `file://`, still runs the whole application.
 * Offline is the only thing lost, and nothing has claimed it yet at this point.
 */
export function startServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  const base = import.meta.env.BASE_URL
  navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base, type: 'classic' })
    .then((registration) => {
      if (registration.active && !registration.waiting) {
        state.offlineReady = true
        publish()
      }
      watch(registration)
    })
    .catch(() => {
      // No offline mode. Everything else is unaffected.
    })
}

export function onServiceWorker(listener: Listener): () => void {
  listeners.add(listener)
  listener({ ...state })
  return () => listeners.delete(listener)
}

/**
 * Take the waiting build and reload. Only ever called from a click.
 *
 * The reload is driven by `controllerchange` rather than fired immediately, so
 * the page comes back under the new worker instead of racing it.
 */
export function applyUpdate(): void {
  if (!waiting) return
  navigator.serviceWorker.addEventListener('controllerchange', () => globalThis.location.reload(), {
    once: true,
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}
