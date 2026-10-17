import { PureComponent } from 'react';

class ErrorBoundary extends PureComponent {
  constructor(props) {
    super(props);
    this.state = { error: false };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ error: true });
    console.error('WebBrain new tab crashed:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="criticalError">
          <div className="criticalError-message">
            <h1>The WebBrain new tab hit an error</h1>
            <p>Reload the tab. If it keeps happening, reset the new tab settings or report it.</p>
            <div className="criticalError-actions">
              <button onClick={() => window.location.reload()}>Reload</button>
              <a href="https://github.com/esokullu/webbrain/issues/new" target="_blank" rel="noreferrer">
                Report issue
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
