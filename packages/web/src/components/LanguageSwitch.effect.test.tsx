import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';
import { NavPills } from './NavPills';

afterEach(() => {
  localStorage.clear();
  void i18n.changeLanguage('en');
});

describe('language switching', () => {
  it('re-renders nav labels when the language changes', async () => {
    render(
      <MemoryRouter>
        <LanguageSwitcher />
        <NavPills />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(screen.getByRole('link', { name: '主控台' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});
