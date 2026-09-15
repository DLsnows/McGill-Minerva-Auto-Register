import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CourseForm } from './CourseForm';

const REQUIRED_FIELDS = ['Term', 'Subject', 'Faculty', 'Course #', 'Target CRN'];
const OPTIONAL_FIELDS = ['Label'];

/** The visible marker text of a field (the accessible expression is `required`/`aria-required`). */
const markerText = (label: string, pattern: RegExp) => {
  const input = screen.getByLabelText(label);
  const wrapper = input.closest('label');
  if (!wrapper) throw new Error(`no <label> wrapping ${label}`);
  return within(wrapper).getByText(pattern).textContent;
};

describe('CourseForm', () => {
  it('marks required fields as required for assistive tech and shows the * mark', () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    for (const label of REQUIRED_FIELDS) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAccessibleName(label);
      expect(input).toHaveAttribute('aria-required', 'true');
      expect(input).toBeRequired();
      expect(markerText(label, /^\*$/)).toBe('*');
      // the mark also carries a localised equivalent for screen readers
      expect(markerText(label, /^required$/)).toBe('required');
    }
  });

  it('marks optional fields as optional and never as required', () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    for (const label of OPTIONAL_FIELDS) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAccessibleName(label);
      expect(input).not.toHaveAttribute('aria-required');
      expect(input).not.toBeRequired();
      expect(markerText(label, /\(optional\)/)).toContain('(optional)');
      expect(within(screen.getByLabelText(label).closest('label')!).queryByText(/^\*$/)).not.toBeInTheDocument();
    }
  });

  it('renders the required/optional legend', () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    expect(screen.getByText(/marked with \* are required/i)).toBeInTheDocument();
  });

  it('explains that the mode field has a default instead of looking mandatory', () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    const mode = screen.getByLabelText('Mode');
    expect(mode).toHaveValue('auto');
    expect(mode).not.toBeRequired();
    expect(screen.getByText(/defaults to “auto”/i)).toBeInTheDocument();
  });

  it('blocks submit until required fields are filled', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    // fallback error bar is kept
    expect(screen.getByText(/required fields/i)).toBeInTheDocument();
  });

  it('flags exactly the missing fields when only some required fields are filled', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Subject')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Faculty')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Target CRN')).toHaveAttribute('aria-invalid', 'true');
    // the two the user did fill in are not flagged
    expect(screen.getByLabelText('Term')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Course #')).not.toHaveAttribute('aria-invalid');
    // and each flagged field gets its own message, wired via aria-describedby
    const subject = screen.getByLabelText('Subject');
    expect(subject).toHaveAccessibleDescription('This field is required.');
    expect(screen.getAllByText('This field is required.')).toHaveLength(3);
  });

  it('treats whitespace-only input as missing', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), '   ');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Faculty')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Term')).not.toHaveAttribute('aria-invalid');
  });

  it('clears the highlight of a field as soon as it is filled in', async () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Term')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    expect(screen.getByLabelText('Term')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Subject')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not flag anything for the optional label field', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Label')).not.toHaveAttribute('aria-invalid');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ label: '' }));
  });

  it('submits trimmed values when valid (faculty required)', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith({
      term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', faculty: 'Faculty of Science', label: '', mode: 'auto',
    });
  });

  it('blocks submit when faculty is missing', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Faculty')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/required fields/i)).toBeInTheDocument();
  });

  it('submits when the form is submitted with Enter from a field', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a help tooltip with the English term + example for each field', () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    // term help maps season → code; faculty help notes it is required
    expect(screen.getByRole('img', { name: /Minerva term code/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /required for the search/i })).toBeInTheDocument();
  });

  it('clears the validation error once the user edits a field', async () => {
    render(<CourseForm onSubmit={() => {}} submitLabel="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/required fields/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Term'), '2');
    expect(screen.queryByText(/required fields/i)).not.toBeInTheDocument();
  });

  it('renders the marks in every locale (zh / en / fr stay in sync)', async () => {
    const i18n = (await import('../i18n')).default;
    try {
      for (const [lang, optional, legend, labelField, requiredField] of [
        ['zh', '（选填）', /带 \* 的为必填项/, '标签', '学期'],
        ['en', '(optional)', /marked with \* are required/, 'Label', 'Term'],
        ['fr', '(facultatif)', /marqués d’un \* sont obligatoires/, 'Étiquette', 'Trimestre'],
      ] as const) {
        await i18n.changeLanguage(lang);
        const { unmount } = render(<CourseForm onSubmit={() => {}} submitLabel="X" />);
        expect(screen.getByText(optional)).toBeInTheDocument();
        expect(screen.getByText(legend)).toBeInTheDocument();
        expect(screen.getByLabelText(labelField)).not.toHaveAttribute('aria-required');
        expect(screen.getByLabelText(requiredField)).toHaveAttribute('aria-required', 'true');
        unmount();
      }
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('prefills from initial values for editing and still renders the marks', () => {
    render(
      <CourseForm
        submitLabel="Save"
        initial={{ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '1814', faculty: '', label: 'COMP 551', mode: 'notify' }}
        onSubmit={() => {}}
      />,
    );
    expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe('1814');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('notify');
    // the edit form reuses the same component, so the marks are rendered there too
    expect(screen.getByText(/marked with \* are required/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Faculty')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Label')).not.toHaveAttribute('aria-required');
  });
});
