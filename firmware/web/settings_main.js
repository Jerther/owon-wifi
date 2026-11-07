import { SettingsApp } from './components/settings_app/settings_app.js';
import { mount } from './core/owl.js';
import { applyTheme, loadThemeChoice } from './core/theme.js';

applyTheme(loadThemeChoice());
mount(SettingsApp, document.body, { templates: TEMPLATES });
