import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Ticker } from './Ticker';

const budget = {
  query: { used: 12, limit: 100, remaining: 88 },
  register: { used: 1, limit: 20, remaining: 19 },
};

describe('Ticker', () => {
  it('renders the live counters', () => {
    render(
      <Ticker
        watching={3}
        intervalMinutes={30}
        jitterMinutes={3}
        budget={budget}
        sessionStatus="authenticated"
      />,
    );
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    expect(screen.getByText('1 / 20')).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
  });

  it('shows a placeholder — not a made-up default — before the budget snapshot lands', () => {
    render(<Ticker watching={0} intervalMinutes={30} jitterMinutes={3} sessionStatus="unknown" />);
    expect(screen.getAllByText('— / —')).toHaveLength(2);
    expect(screen.queryByText('100 / 100')).toBeNull();
    expect(screen.queryByText('20 / 20')).toBeNull();
  });

  it('never renders a numerator larger than its denominator (defensive clamp)', () => {
    // Deliberately impossible input: the invariant is enforced at the render
    // boundary too, so even a broken upstream can't paint "9000 / 1000".
    render(
      <Ticker
        watching={1}
        intervalMinutes={30}
        jitterMinutes={3}
        budget={{
          query: { used: 9000, limit: 1000, remaining: -8000 },
          register: { used: 500, limit: 20, remaining: -480 },
        }}
        sessionStatus="authenticated"
      />,
    );
    expect(screen.getByText('1000 / 1000')).toBeInTheDocument();
    expect(screen.getByText('20 / 20')).toBeInTheDocument();
    expect(screen.queryByText('9000 / 1000')).toBeNull();
    expect(screen.queryByText('500 / 20')).toBeNull();
  });

  it('clamps a negative used-count up to zero', () => {
    render(
      <Ticker
        watching={1}
        intervalMinutes={30}
        jitterMinutes={3}
        budget={{
          query: { used: -5, limit: 100, remaining: 105 },
          register: { used: -1, limit: 20, remaining: 21 },
        }}
        sessionStatus="authenticated"
      />,
    );
    expect(screen.getByText('0 / 100')).toBeInTheDocument();
    expect(screen.getByText('0 / 20')).toBeInTheDocument();
  });
});
