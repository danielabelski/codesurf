import React from 'react'
import * as ReactDOM from 'react-dom/client'
import App from './App'

interface RootErrorBoundaryState {
  hasError: boolean
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[renderer] Unhandled error in app root', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#fff', background: '#1e1e1e' }}>
          <div>CodeSurf encountered an unexpected error. Check the console for details.</div>
        </div>
      )
    }
    return this.props.children
  }
}

export function bootstrap(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>
  )
}
