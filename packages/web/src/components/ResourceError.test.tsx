import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResourceError } from './ResourceError';

const refetch = vi.fn().mockResolvedValue({ ok: true });

describe('ResourceError', () => {
  it('renders nothing when the resource has no error', () => {
    const { container } = render(
      <ResourceError resource={{ error: undefined, refetch }} label="Courses" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the status and URL readable', () => {
    render(
      <ResourceError
        resource={{ error: new Error('GET /api/targets failed: 503 — upstream down'), refetch }}
        label="Courses"
      />,
    );
    expect(
      screen.getByText('⚠️ Could not load Courses: GET /api/targets failed: 503 — upstream down'),
    ).toBeInTheDocument();
  });

  it('clips a proxy HTML error page to one bounded line', () => {
    // `api.req` builds its message from the full response body, so a 502 arrives
    // as an entire HTML document. Verbatim that is a wall of markup in an inline
    // alert; the actionable head (status + URL) has to survive.
    const html = `<html>\n  <head><title>502 Bad Gateway</title></head>\n  <body>${'<p>nginx</p>'.repeat(200)}</body>\n</html>`;
    render(
      <ResourceError
        resource={{ error: new Error(`GET /api/settings failed: 502 — ${html}`), refetch }}
        label="Poll cadence"
      />,
    );

    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).not.toContain('\n');
    expect(text).toContain('GET /api/settings failed: 502');
    expect(text).toContain('…');
    // 6 = "⚠️ " + the separator space … bounded loosely rather than exactly, so
    // rewording the prefix or the label does not break the contract being tested.
    expect(text.length).toBeLessThan(220);
  });
});
