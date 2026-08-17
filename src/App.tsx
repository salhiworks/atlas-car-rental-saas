import { AppProviders } from './app/providers/AppProviders'
import { AppRouter } from './app/routes/AppRouter'
import { ConfigurationRequired } from './components/feedback/ConfigurationRequired'
import { ErrorBoundary } from './components/feedback/ErrorBoundary'
import { getEnvironment } from './lib/config/env'

export function App() {
  const environment = getEnvironment()

  // Checked before anything mounts. Starting the application against a missing
  // or privileged key would either fail obscurely on the first query or, worse,
  // succeed with a key that bypasses every tenant boundary.
  if (environment.status !== 'ok') {
    return <ConfigurationRequired problems={environment.problems} />
  }

  return (
    <ErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </ErrorBoundary>
  )
}
