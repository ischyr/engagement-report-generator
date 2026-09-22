import { Component } from 'react';
import { AlertOctagon, RefreshCw, RotateCcw } from 'lucide-react';

import { Button } from '../ui/Button.jsx';
import { Card, CardBody } from '../ui/Card.jsx';

/**
 * What the app shows when a page throws.
 *
 * React unmounts the whole tree below an error it cannot handle, and with nothing to catch it that
 * tree is the entire application — so a single undefined read in one tab of one engagement gave a
 * white page with the console as the only clue. For an operator mid-engagement that is
 * indistinguishable from the server being down, and what they do about it is reload and lose
 * whatever they had typed.
 *
 * Deliberately a class. Error boundaries are the one thing hooks still cannot express, and a
 * third-party dependency for it would be more surface than the twenty lines it takes.
 *
 * ## Where it sits
 *
 * Around the page, inside the shell. The navigation, the notifications and the presence heartbeat
 * are not what failed, and a boundary at the root would take them down with the page — leaving
 * somebody with no way out except the address bar. Keyed on the location by its caller, so
 * navigating away from a broken page clears it rather than showing the same wreck on the next one.
 *
 * ## What it does not do
 *
 * It does not report anywhere. An error reporter is a decision about sending a client's data to a
 * third party, and this is a self-hosted app whose whole premise is that it does not. The message
 * is logged to the console where a browser's own tools can reach it, and shown in full to the
 * person looking at it — who, on this kind of instance, is very often the person who can fix it.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    /* The console is where a browser's own tools can reach it, and the only place we send it. */
    console.error('A page failed to render:', error, info?.componentStack);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 py-10">
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <AlertOctagon size={20} className="mt-0.5 shrink-0 text-crit" />
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-fg">This page stopped</h1>
                <p className="mt-1 text-xs text-fg-muted">
                  Something in it threw an error, so React took it down rather than draw half of
                  it. The rest of the app is still running — the navigation on the left still
                  works, and nothing you had already saved is affected.
                </p>
              </div>
            </div>

            {/*
              The message, in full and not summarised.
              On a self-hosted instance the person looking at this is very often the person who can
              fix it, and "something went wrong" would waste the one useful thing we have.
            */}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas/60 p-3 font-mono text-[0.6875rem] text-fg-muted">
              {String(error?.message || error)}
              {info?.componentStack ? `\n${info.componentStack.trim()}` : ''}
            </pre>

            <div className="flex flex-wrap items-center gap-2">
              {/*
                Try again first, and reload second. A page that failed on a bad response usually
                comes back on a retry, and a reload costs whatever is in an unsaved editor.
              */}
              <Button
                variant="primary"
                size="sm"
                icon={RotateCcw}
                onClick={() => this.setState({ error: null, info: null })}
              >
                Try again
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                onClick={() => window.location.reload()}
              >
                Reload the app
              </Button>
              <p className="text-[0.625rem] text-fg-subtle">
                Reloading loses anything typed and not saved.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }
}
