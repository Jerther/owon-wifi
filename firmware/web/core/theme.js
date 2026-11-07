// Theme choice shared by every page: auto follows the system, light and dark force a theme.
export const THEME_CHOICES = ['auto', 'light', 'dark'];
const THEME_KEY = 'owon-theme';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let themeChoice = 'auto';

export function loadThemeChoice() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (error) {
    saved = null;
  }
  return THEME_CHOICES.includes(saved) ? saved : 'auto';
}

export function saveThemeChoice(choice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch (error) {
    // Storage can be blocked (private mode); the choice then lasts until the page closes.
  }
  applyTheme(choice);
}

function resolvedTheme() {
  let theme = themeChoice;
  if (theme === 'auto') {
    theme = systemLight.matches ? 'light' : 'dark';
  }
  return theme;
}

function showTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

export function applyTheme(choice) {
  themeChoice = choice;
  showTheme();
}

systemLight.addEventListener('change', showTheme);
