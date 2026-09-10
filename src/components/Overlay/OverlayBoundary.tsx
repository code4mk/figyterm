import React from "react";

/**
 * Stops one broken overlay from taking the whole app with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so a fault in the browser or the editor emptied the window — terminal, tabs,
 * status bar and all — with no message and nothing to click. That happened for
 * real: a hook accidentally placed after an early `return null` changed the
 * hook count between renders, which React reports by throwing.
 *
 * A terminal should survive its own modals. Each overlay gets one of these, so
 * the worst case is that overlay closing with an explanation while the shell
 * behind it keeps running.
 */

interface OverlayBoundaryProps {
  /** Named in the message: "The browser hit an error…". */
  label: string;
  /** Closes the overlay, so dismissing actually puts it away. */
  onDismiss?: () => void;
  children: React.ReactNode;
}

interface OverlayBoundaryState {
  error: Error | null;
}

export class OverlayBoundary extends React.Component<
  OverlayBoundaryProps,
  OverlayBoundaryState
> {
  state: OverlayBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): OverlayBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Logged in full: the card below is deliberately short, and the stack is
    // the only thing that makes the fault diagnosable afterwards.
    console.error(`overlay: ${this.props.label} failed`, error, info.componentStack);
  }

  private dismiss = () => {
    // Cleared as well as closed, so reopening the overlay gets a fresh attempt
    // rather than the error card again.
    this.setState({ error: null });
    this.props.onDismiss?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="overlay-boundary fixed inset-0 z-[400] flex items-center justify-center">
        <div className="overlay-boundary-card w-[380px] max-w-[90vw] rounded-xl p-4">
          <div className="overlay-boundary-title text-[13px] font-semibold">
            The {this.props.label} hit an error
          </div>
          <div className="overlay-boundary-message mt-1.5 text-[12px] leading-relaxed">
            It has been closed so the rest of FigyTerm keeps working. The details
            are in the developer console.
          </div>
          <div className="overlay-boundary-detail mt-1.5 text-[11px] truncate" title={error.message}>
            {error.message}
          </div>
          <div className="mt-4 flex items-center justify-end">
            <button
              className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
              onClick={this.dismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }
}
