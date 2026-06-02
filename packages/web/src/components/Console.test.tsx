import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
