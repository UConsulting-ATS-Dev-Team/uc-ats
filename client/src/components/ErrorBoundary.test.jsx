import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import ErrorBoundary from './ErrorBoundary';
import { queuedEvents, resetTracker } from '../analytics/tracker';
import { resetErrorTracking } from '../analytics/errorTracking';

function Boom() {
  throw new Error('render exploded');
}

beforeEach(() => {
  resetTracker();
  resetErrorTracking();
  // React logs the caught error; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('shows a reload screen instead of a blank page, and reports the error', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong on this page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    const [event] = queuedEvents().filter((e) => e.type === 'js_error');
    expect(event).toMatchObject({ name: 'render exploded', meta: { source: 'render' } });
  });
});
