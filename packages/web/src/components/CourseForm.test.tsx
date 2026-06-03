import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CourseForm } from './CourseForm';

describe('CourseForm', () => {
  it('blocks submit until required fields are filled', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/are required/i)).toBeInTheDocument();
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
    expect(screen.getByText(/are required/i)).toBeInTheDocument();
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
    expect(screen.getByText(/are required/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Term'), '2');
    expect(screen.queryByText(/are required/i)).not.toBeInTheDocument();
  });

  it('prefills from initial values for editing', () => {
    render(
      <CourseForm
        submitLabel="Save"
        initial={{ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '1814', faculty: '', label: 'COMP 551', mode: 'notify' }}
        onSubmit={() => {}}
      />,
    );
    expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe('1814');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('notify');
  });
});
