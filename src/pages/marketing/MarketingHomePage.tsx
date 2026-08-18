import { Differentiation } from './components/Differentiation'
import { FeatureGrid } from './components/FeatureGrid'
import { FinalCta } from './components/FinalCta'
import { Hero } from './components/Hero'
import { MarketingFooter } from './components/MarketingFooter'
import { MarketingHeader } from './components/MarketingHeader'
import { StorySections } from './components/StorySections'

/**
 * The public, customer-facing homepage — shown at `/` to a signed-out
 * visitor only (see the `publicHome` branch in `RequireAuth`). An
 * authenticated user never sees this: `/` opens the Overview dashboard for
 * them exactly as it always has.
 *
 * This is its own lazy route chunk (see AppRouter.tsx), so nothing here pulls
 * in the authenticated shell, its feature modules, MapLibre or React PDF —
 * a signed-out visit to `/` downloads only this page.
 */
export function MarketingHomePage() {
  return (
    <div className="bg-canvas min-h-dvh">
      <MarketingHeader />
      <main id="main">
        <Hero />
        <StorySections />
        <FeatureGrid />
        <Differentiation />
        <FinalCta />
      </main>
      <MarketingFooter />
    </div>
  )
}
