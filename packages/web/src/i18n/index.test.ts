import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGS, detectInitialLang, setLang } from './index';

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

  // The operation-speed settings are user-facing copy: every language must
  // actually carry it (the `typeof en` dictionaries catch missing keys at
  // compile time; this catches empty or un-interpolated strings).
  it('carries the operation-speed settings copy in all three languages', () => {
    const keys = [
      'settings.pacingSection',
      'settings.opPause',
      'settings.opJitter',
      'settings.pacingHint',
      'settings.pacingRange',
    ];
    for (const lang of LANGS) {
      void i18n.changeLanguage(lang);
      for (const key of keys) {
        const value = i18n.t(key, { min: 250, max: 60000 });
        expect(value, `${lang} → ${key}`).not.toBe(key);
        expect(value, `${lang} → ${key}`).not.toContain('{{');
        expect(value.trim().length, `${lang} → ${key}`).toBeGreaterThan(0);
      }
    }
  });
});
