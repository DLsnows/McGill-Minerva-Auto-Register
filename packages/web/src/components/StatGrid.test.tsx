import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatGrid } from './StatGrid';

const stats = { crn: '2347', cap: 180, act: 180, rem: 0, wlcap: 40, wlact: 38, wlrem: 2 };

describe('StatGrid', () => {
  it('renders all six values', () => {
    render(<StatGrid stats={stats} />);
    for (const v of ['180', '0', '40', '38', '2']) expect(screen.getAllByText(v).length).toBeGreaterThan(0);
    expect(screen.getByText('cap')).toBeInTheDocument();
    expect(screen.getByText('wlrem')).toBeInTheDocument();
  });

  it('shows a placeholder when stats are absent', () => {
    render(<StatGrid stats={undefined} />);
    expect(screen.getAllByText('—').length).toBe(6);
  });
});
