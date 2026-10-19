import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw, Terminal } from 'lucide-react'
import { ChatOverlayPanel } from './ChatOverlayPanel'

interface TerminalRecoveryBoundaryProps {
  children: ReactNode
  onClose: () => void
}

interface TerminalRecoveryBoundaryState {
  error: boolean
  attempt: number
}

export class TerminalRecoveryBoundary extends Component<TerminalRecoveryBoundaryProps, TerminalRecoveryBoundaryState> {
  state: TerminalRecoveryBoundaryState = { error: false, attempt: 0 }

  static getDerivedStateFromError(): Partial<TerminalRecoveryBoundaryState> {
    return { error: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Codex Remote] 本机终端界面异常', error, info.componentStack)
  }

  private retry = () => {
    this.setState((current) => ({ error: false, attempt: current.attempt + 1 }))
  }

  render() {
    if (this.state.error) {
      return (
        <ChatOverlayPanel
          ariaLabel="本机终端"
          backdropLabel="关闭本机终端"
          onClose={this.props.onClose}
          showCloseButton={false}
          className="terminal-dialog"
          header={(
            <div className="terminal-dialog__title">
              <Terminal size={16} aria-hidden="true" />
              <strong>本机终端</strong>
            </div>
          )}
        >
          <div className="terminal-dialog__error" role="alert">
            <p>终端界面遇到问题，聊天仍可继续。</p>
            <div>
              <button type="button" onClick={this.retry}><RotateCw size={14} />重试终端</button>
              <button type="button" onClick={this.props.onClose}>关闭终端</button>
            </div>
          </div>
        </ChatOverlayPanel>
      )
    }
    return <div key={this.state.attempt}>{this.props.children}</div>
  }
}
