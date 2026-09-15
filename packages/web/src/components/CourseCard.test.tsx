import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CourseCard } from './CourseCard';
import type { WatchTarget } from '@autoregister/shared';

const target: WatchTarget = {
  id: 't1',
  label: 'COMP 551',
  term: '202701',
  subject: 'COMP',
  courseNumber: '551',
  targetCrn: '2347',
  mode: 'notify',
  status: 'watching',
  createdAt: 0,
  lastStats: { crn: '2347', cap: 180, act: 180, rem: 0, wlcap: 40, wlact: 38, wlrem: 2 },
};

const noop = () => {};

describe('CourseCard', () => {
  it('renders title, CRN, badge and stats', () => {
    render(<CourseCard target={target} onToggleMode={noop} onRun={noop} onTogglePolling={noop} />);
    expect(screen.getByText(/COMP 551/)).toBeInTheDocument();
    expect(screen.getByText(/CRN 2347/)).toBeInTheDocument();
    expect(screen.getByText('WATCHING')).toBeInTheDocument();
  });

  it('fires onToggleMode with the flipped mode', async () => {
    const onToggleMode = vi.fn();
    render(<CourseCard target={target} onToggleMode={onToggleMode} onRun={noop} onTogglePolling={noop} />);
    await userEvent.click(screen.getByRole('button', { name: /toggle mode/i }));
    expect(onToggleMode).toHaveBeenCalledWith('t1', 'auto');
  });

  it('fires onRun with the target id when Register now is clicked', async () => {
    const onRun = vi.fn();
    render(<CourseCard target={target} onToggleMode={noop} onRun={onRun} onTogglePolling={noop} />);
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    expect(onRun).toHaveBeenCalledWith('t1');
  });

  it('pauses a watching course (onTogglePolling → paused)', async () => {
    const onTogglePolling = vi.fn();
    render(<CourseCard target={target} onToggleMode={noop} onRun={noop} onTogglePolling={onTogglePolling} />);
    await userEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(onTogglePolling).toHaveBeenCalledWith('t1', 'paused');
  });

  it('resumes a paused course (onTogglePolling → watching)', async () => {
    const onTogglePolling = vi.fn();
    render(
      <CourseCard target={{ ...target, status: 'paused' }} onToggleMode={noop} onRun={noop} onTogglePolling={onTogglePolling} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onTogglePolling).toHaveBeenCalledWith('t1', 'watching');
  });

  it('disables Resume and Register now when not logged in (Pause stays enabled)', () => {
    const { rerender } = render(
      <CourseCard target={{ ...target, status: 'paused' }} onToggleMode={noop} onRun={noop} onTogglePolling={noop} loggedIn={false} />,
    );
    expect(screen.getByRole('button', { name: /resume/i })).toBeDisabled();

    rerender(<CourseCard target={target} onToggleMode={noop} onRun={noop} onTogglePolling={noop} loggedIn={false} />);
    expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /pause/i })).toBeEnabled();
  });

  it('offers no Pause/Resume for completed states (registered), but a recovery action for error', () => {
    const { rerender } = render(
      <CourseCard target={{ ...target, status: 'error' }} onToggleMode={noop} onRun={noop} onTogglePolling={noop} />,
    );
    expect(screen.queryByRole('button', { name: /^▶ resume$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    // 'error' is recoverable — the breaker parked it, the user can revive it.
    expect(screen.getByRole('button', { name: /resume watching/i })).toBeInTheDocument();

    rerender(<CourseCard target={{ ...target, status: 'registered' }} onToggleMode={noop} onRun={noop} onTogglePolling={noop} />);
    expect(screen.queryByRole('button', { name: /^▶ resume$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resume watching/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
  });

  // Regression: the failure breaker sets status 'error' and the card used to
  // render no way out of it at all (no pause, no resume, no immediate run) —
  // only deleting and re-creating the course worked.
  it('revives an error course through onResume', async () => {
    const onResume = vi.fn();
    render(
      <CourseCard
        target={{ ...target, status: 'error' }}
        onToggleMode={noop}
        onRun={noop}
        onTogglePolling={noop}
        onResume={onResume}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /resume watching/i }));
    expect(onResume).toHaveBeenCalledWith('t1');
  });

  it('blocks the error recovery action when logged out', () => {
    render(
      <CourseCard
        target={{ ...target, status: 'error' }}
        onToggleMode={noop}
        onRun={noop}
        onTogglePolling={noop}
        onResume={noop}
        loggedIn={false}
      />,
    );
    expect(screen.getByRole('button', { name: /resume watching/i })).toBeDisabled();
  });
});
