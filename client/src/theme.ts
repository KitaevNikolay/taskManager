// Тема оформления: auto (как в системе) | light | dark. Выбор хранится у пользователя и в localStorage —
// чтобы применить его до загрузки приложения (см. скрипт в index.html).
export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'theme';
const mql = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current: ThemePref = 'auto';

function resolve(pref: ThemePref) {
  return pref === 'auto' ? (mql?.matches ? 'dark' : 'light') : pref;
}

export function applyTheme(pref: ThemePref) {
  current = pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* приватный режим — тема просто не запомнится в этом браузере */
  }
  document.documentElement.dataset.theme = resolve(pref);
}

export const savedTheme = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
};

// В режиме «авто» следуем за сменой темы в системе
mql?.addEventListener('change', () => current === 'auto' && applyTheme('auto'));
