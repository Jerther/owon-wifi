import { clip, restoreSettings } from '../scope_logic.js';
import { reactive } from './owl.js';

const STORAGE_KEY = 'owon-vds1022-v1';
export const GRID_BRIGHTNESS_RANGE = { min: 0.3, max: 3, step: 0.1 };
export const TRACE_WIDTH_RANGE = { min: 1, max: 4, step: 0.5 };

function defaultUi() {
  return { view: 'time', cursorsV: false, cursorsT: false, cursorChannel: 0, vCursors: [0.35, 0.65], tCursors: [0.35, 0.65] };
}

function restoreFractions(saved, fallback) {
  const valid = Array.isArray(saved) && saved.length === 2 && saved.every((value) => Number.isFinite(value));
  return valid ? saved.map((value) => clip(value, 0, 1)) : fallback;
}

function restoreUi(saved) {
  const base = defaultUi();
  const source = saved || {};
  return {
    view: ['time', 'fft', 'xy'].includes(source.view) ? source.view : base.view,
    cursorsV: source.cursorsV === true,
    cursorsT: source.cursorsT === true,
    cursorChannel: source.cursorChannel === 1 ? 1 : 0,
    vCursors: restoreFractions(source.vCursors, base.vCursors),
    tCursors: restoreFractions(source.tCursors, base.tCursors),
  };
}

function restoreNumber(saved, range, fallback) {
  return Number.isFinite(saved) ? clip(saved, range.min, range.max) : fallback;
}

// gridBrightness multiplies the grid's default brightness; traceWidth is in CSS pixels.
function restoreDisplay(saved) {
  const source = saved || {};
  return {
    gridBrightness: restoreNumber(source.gridBrightness, GRID_BRIGHTNESS_RANGE, 1),
    traceWidth: restoreNumber(source.traceWidth, TRACE_WIDTH_RANGE, 1.5),
  };
}

function loadSaved() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    saved = null;
  }
  return saved || {};
}

// Everything the user sets and the browser keeps: scope settings, view choices and display preferences.
export function createStore() {
  const saved = loadSaved();
  return reactive({
    settings: restoreSettings(saved.settings),
    ui: restoreUi(saved.ui),
    display: restoreDisplay(saved.display),
  });
}

export function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    // Storage can be blocked (private mode); the app works without it.
  }
}

export function getPath(root, path) {
  return path.split('.').reduce((node, key) => node[key], root);
}

export function setPath(root, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((node, key) => node[key], root)[last] = value;
}

// Cursors only show in the time view.
export function cursorAxes(ui) {
  const timeView = ui.view === 'time';
  return { vertical: ui.cursorsV && timeView, horizontal: ui.cursorsT && timeView };
}
