import { afterEach, describe, expect, it } from 'vitest';
import i18n, { detectInitialLang, setLang } from './index';

afterEach(() => {
  localStorage.clear();
  void i18n.changeLanguage('en');
});

describe('i18n', () => {
  it('translates a key in each language', () => {
    void i18n.changeLanguage('en');
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
    void i18n.changeLanguage('zh');
    expect(i18n.t('nav.dashboard')).toBe('主控台');
    void i18n.changeLanguage('fr');
    expect(i18n.t('nav.dashboard')).toBe('Tableau de bord');
  });

  it('setLang changes language and persists to localStorage', () => {
    setLang('fr');
    expect(i18n.language).toBe('fr');
    expect(localStorage.getItem('autoreg.lang')).toBe('fr');
  });

  it('detectInitialLang prefers a saved choice', () => {
    localStorage.setItem('autoreg.lang', 'zh');
    expect(detectInitialLang()).toBe('zh');
  });

  it('interpolates values', () => {
    void i18n.changeLanguage('en');
    expect(i18n.t('ticker.minSuffix', { j: 3 })).toBe('± 3 min');
  });
});
