import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

interface AppRecoveryBoundaryProps {
  children: ReactNode
}

interface AppRecoveryBoundaryState {
  hasError: boolean
  recoveryKey: number
}

/**
 * Never leave a mobile browser on the root's dark background when a transient
 * React rendering error occurs during foreground restoration.
 */
export class AppRecoveryBoundary extends Component<AppRecoveryBoundaryProps, AppRecoveryBoundaryState> {
  state: AppRecoveryBoundaryState = { hasError: false, recoveryKey: 0 }
  private automaticRecoveryAt = 0
  private recoveryTimer: number | undefined

  static getDerivedStateFromError(): Partial<AppRecoveryBoundaryState> {
    return { hasError: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    const now = Date.now()
    // One retry is enough for a transient foreground/HMR render race. A
    // repeated error stays visible with clear recovery controls instead of
    // creating a reload loop.
    if (now - this.automaticRecoveryAt < 10_000) return
    this.automaticRecoveryAt = now
    this.recoveryTimer = window.setTimeout(() => this.recover(), 350)
  }

  componentWillUnmount() {
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer)
  }

  private recover = () => {
    if (this.recoveryTimer !== undefined) {
      window.clearTimeout(this.recoveryTimer)
      this.recoveryTimer = undefined
    }
    this.setState((current) => ({ hasError: false, recoveryKey: current.recoveryKey + 1 }))
  }

  private reload = () => window.location.reload()

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-recovery" role="alert">
          <section className="app-recovery__card">
            <span className="app-recovery__mark">C</span>
            <h1>页面正在恢复</h1>
            <p>聊天数据仍保留在本机，正在重新连接界面。</p>
            <div className="app-recovery__actions">
              <button type="button" onClick={this.recover}>重新恢复</button>
              <button type="button" onClick={this.reload}>刷新页面</button>
            </div>
          </section>
        </main>
      )
    }
    return <Fragment key={this.state.recoveryKey}>{this.props.children}</Fragment>
  }
}
