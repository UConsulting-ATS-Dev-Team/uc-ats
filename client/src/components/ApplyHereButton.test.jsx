import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import ApplyHereButton from './ApplyHereButton';

const href = 'https://docs.google.com/forms/d/abc/viewform';

afterEach(() => vi.useRealTimers());

describe('ApplyHereButton', () => {
  it('opens the form in a new tab and says it is a Google Form', () => {
    render(<ApplyHereButton href={href} />);
    const link = screen.getByRole('link', { name: /apply here/i });
    expect(link).toHaveAttribute('href', href);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Opens the application Google Form/)).toBeInTheDocument();
  });

  it('tells candidates who already submitted that they need not resubmit', () => {
    render(<ApplyHereButton href={href} />);
    expect(screen.getByRole('note')).toHaveTextContent(/apologize for the outages/i);
    expect(screen.getByRole('note')).toHaveTextContent(/do not need to resubmit/i);
  });

  it('renders nothing without a link', () => {
    const { container } = render(<ApplyHereButton href={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once the deadline has passed', () => {
    const { container } = render(<ApplyHereButton href={href} closesAt="2000-01-01T00:00:00.000Z" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself when the deadline arrives while the page is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T06:58:00.000Z'));
    render(<ApplyHereButton href={href} closesAt="2026-10-02T06:59:00.000Z" />);
    expect(screen.getByRole('link', { name: /apply here/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60 * 1000);
    });

    expect(screen.queryByRole('link', { name: /apply here/i })).not.toBeInTheDocument();
  });
});
