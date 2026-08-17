import '@testing-library/jest-dom/vitest'

/**
 * jsdom does not implement ResizeObserver, which the chart uses to render at
 * real pixel dimensions. A stub that reports a fixed width is enough to
 * exercise the drawing logic.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** jsdom reports every element as zero-width; give charts something to draw into. */
if (typeof Element !== 'undefined') {
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 720
    },
  })
}
