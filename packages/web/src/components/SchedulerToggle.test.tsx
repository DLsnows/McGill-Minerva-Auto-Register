import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulerToggle } from './SchedulerToggle';

describe('SchedulerToggle', () => {
  it('shows Start when stopped and calls onStart', async () => {
    const onStart = vi.fn();
    render(<SchedulerToggle running={false} onStart={onStart} onStop={() => {}} />);
    expect(screen.getByText(/stopped/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it('shows Stop when running and calls onStop', async () => {
    const onStop = vi.fn();
    render(<SchedulerToggle running={true} onStart={() => {}} onStop={onStop} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
