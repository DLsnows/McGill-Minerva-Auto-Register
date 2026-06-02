import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Ticker } from './Ticker';

describe('Ticker', () => {
  it('renders the live counters', () => {
    render(
      <Ticker
        watching={3}
        intervalMinutes={30}
        jitterMinutes={3}
        queryUsed={12}
        queryBudget={100}
        registerUsed={1}
        registerBudget={20}
        sessionStatus="authenticated"
      />,
    );
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
  });
});
