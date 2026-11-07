import { ScopeApp } from './components/scope_app/scope_app.js';
import { mount } from './core/owl.js';
import { ScopeSession } from './core/scope_session.js';
import { createStore } from './core/store.js';
import { applyTheme, loadThemeChoice } from './core/theme.js';

applyTheme(loadThemeChoice());
const scopeStore = createStore();
const scopeSession = new ScopeSession(scopeStore);
mount(ScopeApp, document.body, { env: { store: scopeStore, session: scopeSession }, templates: TEMPLATES });
scopeSession.start();
