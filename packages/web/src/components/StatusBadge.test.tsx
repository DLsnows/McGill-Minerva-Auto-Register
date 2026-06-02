import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders the status label and the matching class', () => {
    const { container } = render(<StatusBadge status="waitlisted" />);
    expect(screen.getByText('WAITLISTED')).toBeInTheDocument();
    expect(container.querySelector('.b-wait')).not.toBeNull();
  });
});
