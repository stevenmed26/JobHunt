// src/ErrorBoundary.tsx — catches render errors and shows a clean fallback

import React from "react";

interface Props {
  children: React.ReactNode;
  /** Optional label shown in the error UI, e.g. "Auto Apply" */
  name?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", this.props.name ?? "view", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app">
        <div
          style={{
            margin: "40px auto",
            maxWidth: 480,
            padding: "24px",
            border: "1px solid rgba(255,69,58,0.3)",
            borderRadius: 16,
            background: "rgba(255,69,58,0.06)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {this.props.name ? `${this.props.name} crashed` : "Something went wrong"}
          </div>
          <pre
            style={{
              fontSize: 11,
              color: "rgba(255,255,255,0.55)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: "0 0 16px",
            }}
          >
            {error.message}
          </pre>
          <button
            className="btn btnPrimary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}