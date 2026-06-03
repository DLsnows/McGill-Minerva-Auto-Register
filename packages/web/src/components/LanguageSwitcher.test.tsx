import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

afterEach(() => {
  localStorage.clear();
  void i18n.changeLanguage('en');
});

describe('LanguageSwitcher', () => {
  it('renders the three languages and highlights the active one', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByRole('button', { name: '中文' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN' })).toHaveClass('pill-on');
  });

  it('switches language on click', async () => {
    render(<LanguageSwitcher />);
    await userEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(i18n.language).toBe('zh');
  });
});
