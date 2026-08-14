import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// A render-time throw anywhere in the screen tree (a malformed address, a
// bad BigInt parse, any future screen's bug) previously blanked the ENTIRE
// app with no recovery — no error boundary existed anywhere in App.tsx.
// This catches it at the screen-switch level so the sidebar/nav stays
// usable and the user can navigate away from whatever screen broke,
// instead of needing to restart Apprentice.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="screen">
          <h2>Something went wrong on this screen</h2>
          <p className="muted">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
