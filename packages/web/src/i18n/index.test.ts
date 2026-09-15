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

  it('translates every keep-awake key in all three languages', () => {
    // The keep-awake switch must be explained identically well in zh/en/fr —
    // a missing key would silently fall back to English.
    const keys = [
      'settings.keepAwakeSection',
      'settings.keepAwake',
      'settings.keepAwakeAria',
      'settings.keepAwakeNoSleep',
      'settings.keepAwakeDisplayNote',
      'settings.keepAwakeLaptopNote',
      'settings.keepAwakeDesktopNote',
      'settings.keepAwakeExitNote',
      'settings.keepAwakeStatus',
      'settings.keepAwakeStatusActive',
      'settings.keepAwakeStatusBattery',
      'settings.keepAwakeStatusDisabled',
      'settings.keepAwakeStatusUnavailable',
      'settings.keepAwakeStatusKeeperFailed',
      'settings.keepAwakeStatusUnsupported',
      'settings.keepAwakeStatusPending',
    ];
    for (const lng of LANGS) {
      void i18n.changeLanguage(lng);
      for (const key of keys) {
        const value = i18n.t(key);
        expect(value, `${lng} is missing ${key}`).not.toBe(key);
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
