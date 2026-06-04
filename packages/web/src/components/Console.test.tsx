import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Console } from './Console';
import type { LogEvent } from '@autoregister/shared';

const events: LogEvent[] = [
  { id: '1', ts: new Date(2026, 5, 2, 10, 42, 1).getTime(), level: 'info', message: 'polling…' },
  { id: '2', ts: new Date(2026, 5, 2, 10, 42, 9).getTime(), level: 'ok', message: 'joined waitlist' },
];

describe('Console', () => {
  it('renders each event with a level class and clock timestamp', () => {
    const { container } = render(<Console events={events} connected={true} />);
    expect(screen.getByText('polling…')).toBeInTheDocument();
    expect(container.querySelector('.l-ok')).not.toBeNull();
    expect(screen.getByText('10:42:01')).toBeInTheDocument();
  });

  it('shows a disconnected indicator when not connected', () => {
    render(<Console events={[]} connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('renders newest events first', () => {
    const { container } = render(<Console events={events} connected={true} />);
    const lines = container.querySelectorAll('.log .ln');
    // events are oldest-last; the newer 'joined waitlist' (id 2) shows on top.
    expect(lines[0].textContent).toContain('joined waitlist');
    expect(lines[1].textContent).toContain('polling');
  });

  it('calls onClear when the Clear button is clicked', async () => {
    const onClear = vi.fn();
    render(<Console events={[]} connected={true} onClear={onClear} />);
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it('omits the Clear button when no onClear is given', () => {
    render(<Console events={[]} connected={true} />);
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('lights the green dot when connected and the red dot when reconnecting', () => {
    const { container, rerender } = render(<Console events={[]} connected={true} />);
    expect(container.querySelector('.cg.on')).not.toBeNull();
    expect(container.querySelector('.cr.on')).toBeNull();
    rerender(<Console events={[]} connected={false} />);
    expect(container.querySelector('.cr.on')).not.toBeNull();
    expect(container.querySelector('.cg.on')).toBeNull();
  });
});
