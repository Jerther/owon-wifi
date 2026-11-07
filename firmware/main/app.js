import {
  ADC_RANGE, CH1, EXT, GND, MAX_FFT_SIZE, MODE_STOPPED, SAMPLES, SAMPLING_RATES, SWEEP_AUTO, VOLT_RANGES,
  autosetChannel, buildAllWrites, buildCsv, buildForceTriggerWrites, buildChannelWrites, buildSamplingWrites,
  buildTriggerWrites, channelMask, clip, computeSpectrum, createFft, createFrameSlot, displayedTriggerPosition,
  encodeMode, encodeWrites, fftSizeFor, forceGround, formatSi, frameCount, frameMinMax, fullScaleVolts, hannWindow,
  isOneShot, levelDivAtScreen, measure, offsetAtScreen, parseFlash, parseFrameInto, positionAtScreen,
  rateIndexForPeriod, readSequence, restoreSettings, runModeFor, sampleScale, sampleTimeSeconds, samplingFor,
  screenToVolts, timeRangeSeconds, voltsPerDivision,
} from '/scope_logic.js';

const STORAGE_KEY = 'owon-vds1022-v1';
const TRACE_COLORS = ['#ffd400', '#00d4ff'];
const RECONNECT_MS = 1000;
const FLASH_RETRY_MS = 3000;
const STATS_MS = 1000;
const READOUT_MS = 250;
const PUSH_DELAY_MS = 30;
const DRAG_PUSH_MS = 50;
const SINGLE_GUARD_MS = 150;
const AUTOSET_SETTLE_MS = 300;
const AUTOSET_MAX_TRIES = 10;
const AUTOSET_RATE = 25e3;
const CURSOR_GRAB_PX = 24;
const FFT_SPAN_DB = 100;
const MIN_FFT_SIZE = 16;
const ALL_GROUPS = ['sampling', 'channel0', 'channel1', 'trigger'];

const $ = (id) => document.getElementById(id);
const traceCanvas = $('trace');
const gridCanvas = $('grid');
const traceContext = traceCanvas.getContext('2d');
const gridContext = gridCanvas.getContext('2d');

const app = {
  store: { settings: restoreSettings(null), ui: defaultUi() },
  flash: null,
  link: 'offline',
  running: true,
  single: false,
  socket: null,
  generation: 0,
  pending: new Set(),
  pushTimer: 0,
  latest: null,
  dirty: true,
  gridDirty: true,
  slots: [createFrameSlot(), createFrameSlot()],
  ignoreUntil: 0,
  autoset: null,
  drag: null,
  handleDrag: null,
  activeChannel: 0,
  lastReadout: 0,
  stats: { messages: 0, bytes: 0, skipped: 0, lastSequence: null, roundTrip: null },
  fft: createFftState(),
  measureCells: [],
};

// ---------------------------------------------------------------- persistence

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

function loadSaved() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    saved = null;
  }
  return saved;
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(app.store));
  } catch (error) {
    // Storage can be blocked (private mode); the app works without it.
  }
}

// ---------------------------------------------------------------- connection

function send(data) {
  const socket = app.socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

// Frames already in flight must not pass for the result of a new single capture.
function discardStaleFrames(delay) {
  app.latest = null;
  app.ignoreUntil = performance.now() + delay;
}

function sendMode() {
  const settings = app.store.settings;
  const mode = app.running ? runModeFor(settings, app.single) : MODE_STOPPED;
  if (app.running && isOneShot(settings, app.single)) {
    discardStaleFrames(SINGLE_GUARD_MS);
  }
  send(encodeMode(channelMask(settings), mode));
}

function sendWrites(writes) {
  encodeWrites(writes).forEach((message) => send(message));
}

function writesForGroups(groups) {
  const settings = app.store.settings;
  const calibration = app.flash.calibration;
  const writes = [];
  if (groups.has('sampling')) {
    writes.push(...buildSamplingWrites(settings));
  }
  settings.channels.forEach((channel, index) => {
    if (groups.has(`channel${index}`)) {
      writes.push(...buildChannelWrites(index, channel, calibration));
    }
  });
  if (groups.has('trigger')) {
    writes.push(...buildTriggerWrites(settings, app.single));
  }
  return writes;
}

function flushPending() {
  const groups = app.pending;
  app.pending = new Set();
  app.pushTimer = 0;
  if (app.flash) {
    sendWrites(writesForGroups(groups));
    sendMode();
  }
}

function schedulePush(groups, delay = PUSH_DELAY_MS) {
  groups.forEach((group) => app.pending.add(group));
  if (app.pushTimer === 0) {
    app.pushTimer = setTimeout(flushPending, delay);
  }
}

function flushNow() {
  clearTimeout(app.pushTimer);
  flushPending();
}

function pushEverything() {
  sendWrites(buildAllWrites(app.store.settings, app.flash.calibration, app.single));
  sendMode();
}

function setLink(link) {
  app.link = link;
  refreshState();
}

async function loadFlash(generation) {
  let flash = null;
  try {
    const response = await fetch('/flash');
    flash = response.ok ? parseFlash(await response.arrayBuffer()) : null;
  } catch (error) {
    flash = null;
  }
  if (generation === app.generation) {
    onFlashResult(flash, generation);
  }
}

function onFlashResult(flash, generation) {
  app.flash = flash;
  if (flash) {
    setLink('ready');
    pushEverything();
  } else {
    setLink('waiting');
    setTimeout(() => retryFlash(generation), FLASH_RETRY_MS);
  }
}

function retryFlash(generation) {
  if (app.generation === generation && app.link === 'waiting') {
    loadFlash(generation);
  }
}

function startSession() {
  app.generation++;
  app.flash = null;
  setLink('waiting');
  loadFlash(app.generation);
}

function onText(text) {
  const event = text.startsWith('{') ? parseEvent(text) : null;
  if (event && event.event === 'scope_ready') {
    startSession();
  } else if (Number.isFinite(Number(text))) {
    app.stats.roundTrip = performance.now() - Number(text);
  }
}

function parseEvent(text) {
  let event = null;
  try {
    event = JSON.parse(text);
  } catch (error) {
    event = null;
  }
  return event;
}

function onBinary(message) {
  const stats = app.stats;
  const sequence = readSequence(message);
  if (stats.lastSequence !== null) {
    stats.skipped += Math.max(0, ((sequence - stats.lastSequence - 1) >>> 0));
  }
  stats.lastSequence = sequence;
  stats.messages++;
  stats.bytes += message.byteLength;
  if (app.running && performance.now() >= app.ignoreUntil) {
    app.latest = message;
  }
}

function connect() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = startSession;
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      onText(event.data);
    } else {
      onBinary(event.data);
    }
  };
  socket.onclose = () => {
    app.generation++;
    app.stats.lastSequence = null;
    setLink('offline');
    setTimeout(connect, RECONNECT_MS);
  };
  app.socket = socket;
}

// ---------------------------------------------------------------- settings changes

function getPath(path) {
  return path.split('.').reduce((node, key) => node[key], app.store);
}

function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((node, key) => node[key], app.store)[last] = value;
}

function groupsFor(path) {
  const [, section, index] = path.split('.');
  let groups = ['sampling'];
  if (section === 'channels') {
    groups = [`channel${index}`, 'trigger'];
  } else if (section === 'trigger') {
    groups = ['trigger'];
  }
  return groups;
}

function isLastChannelOff(path, value) {
  const channels = app.store.settings.channels;
  const [, section, index] = path.split('.');
  const turningOff = section === 'channels' && path.endsWith('.on') && value === false;
  return turningOff && !channels[1 - Number(index)].on;
}

function applyChange(path, value, delay = PUSH_DELAY_MS) {
  if (!isLastChannelOff(path, value)) {
    setPath(path, value);
    if (path.startsWith('settings.')) {
      schedulePush(groupsFor(path), delay);
    }
    afterChange();
  }
}

function afterChange() {
  saveStore();
  syncControls();
  app.dirty = true;
  app.gridDirty = true;
}

function controlValue(element) {
  let value = null;
  if (element.matches('input, select')) {
    value = Number(element.value);
  } else if (element.hasAttribute('data-toggle')) {
    value = !getPath(element.dataset.key);
  } else {
    value = JSON.parse(element.dataset.value);
  }
  return value;
}

function bindControls() {
  document.querySelectorAll('[data-key]').forEach((element) => {
    const eventName = element.matches('input, select') ? 'input' : 'click';
    element.addEventListener(eventName, () => applyChange(element.dataset.key, controlValue(element)));
  });
}

// ---------------------------------------------------------------- control display

function rangeLabel(rangeIndex, probe) {
  return `${formatSi((VOLT_RANGES[rangeIndex] * probe) / 10, 'V')}/div`;
}

function fillRangeOptions() {
  document.querySelectorAll('[data-ranges]').forEach((select) => {
    VOLT_RANGES.forEach((_, index) => select.add(new Option('', String(index))));
  });
  const timeSelect = $('time-range');
  for (let index = SAMPLING_RATES.length - 1; index >= 0; index--) {
    const roll = samplingFor(index).roll ? ' (roll)' : '';
    timeSelect.add(new Option(`${formatSi(timeRangeSeconds(index) / 10, 's')}/div${roll}`, String(index)));
  }
}

function updateRangeLabels() {
  document.querySelectorAll('[data-ranges]').forEach((select) => {
    const probe = app.store.settings.channels[Number(select.dataset.ranges)].probe;
    Array.from(select.options).forEach((option, index) => {
      option.textContent = rangeLabel(index, probe);
    });
  });
}

function outputText(path, value) {
  const settings = app.store.settings;
  let text = '';
  if (path.endsWith('.offset')) {
    text = `${(value * 10).toFixed(1)} div`;
  } else if (path.endsWith('levelDiv')) {
    const source = settings.channels[settings.trigger.source];
    text = source ? formatSi(value * voltsPerDivision(source), 'V') : '-';
  } else {
    text = `${Math.round(value * 100)} %`;
  }
  return text;
}

function syncElement(element) {
  const value = getPath(element.dataset.key);
  if (element.matches('input, select')) {
    element.value = String(value);
  } else if (element.hasAttribute('data-toggle')) {
    element.setAttribute('aria-pressed', String(value));
  } else {
    element.setAttribute('aria-pressed', String(value === JSON.parse(element.dataset.value)));
  }
}

function syncControls() {
  const settings = app.store.settings;
  updateRangeLabels();
  document.querySelectorAll('[data-key]').forEach(syncElement);
  document.querySelectorAll('[data-out]').forEach((output) => {
    output.textContent = outputText(output.dataset.out, getPath(output.dataset.out));
  });
  $('level').disabled = settings.trigger.source === EXT;
  traceCanvas.style.touchAction = cursorsActive() ? 'none' : 'pan-y';
  refreshState();
}

const STATE_TEXT = {
  offline: 'No connection', waiting: 'Waiting for the scope', running: 'Running', stopped: 'Stopped',
  single: 'Single: waiting for trigger', autoset: 'Autoset...',
};

function stateName() {
  let name = app.link;
  if (app.link === 'ready') {
    name = app.running ? 'running' : 'stopped';
  }
  if (name === 'running' && app.autoset) {
    name = 'autoset';
  } else if (name === 'running' && isOneShot(app.store.settings, app.single)) {
    name = 'single';
  }
  return name;
}

function refreshState() {
  const name = stateName();
  const pill = $('state');
  pill.textContent = STATE_TEXT[name];
  pill.dataset.state = name === 'single' || name === 'autoset' ? 'running' : name;
  const run = $('run');
  run.textContent = app.running ? 'Stop' : 'Run';
  run.dataset.running = String(app.running);
}

// ---------------------------------------------------------------- actions

// Run also rewrites the trigger so a previous single's Once sweep bits give way to the selected sweep.
function setRunning(running) {
  app.running = running;
  app.single = false;
  discardStaleFrames(PUSH_DELAY_MS + SINGLE_GUARD_MS);
  if (app.flash && running) {
    schedulePush(['trigger']);
  } else if (app.flash) {
    sendMode();
  }
  refreshState();
}

function startSingle() {
  app.running = true;
  app.single = true;
  discardStaleFrames(PUSH_DELAY_MS + SINGLE_GUARD_MS);
  schedulePush(['trigger']);
  refreshState();
}

function exportCsv() {
  const settings = app.store.settings;
  const columns = [];
  app.slots.forEach((slot, index) => {
    if (slot.present) {
      const { scale, shift } = sampleScale(settings.channels[index]);
      columns.push({ name: `CH${index + 1}`, samples: slot.samples, first: slot.first, scale, shift });
    }
  });
  if (columns.length > 0) {
    const text = buildCsv(columns, samplingFor(settings.rateIndex).rate, displayedTriggerPosition(settings));
    download(new Blob([text], { type: 'text/csv' }), `owon-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  }
}

function download(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function bindActions() {
  $('run').addEventListener('click', () => setRunning(!app.running));
  $('single').addEventListener('click', startSingle);
  $('autoset').addEventListener('click', startAutoset);
  $('force').addEventListener('click', () => sendWrites(buildForceTriggerWrites()));
  $('export').addEventListener('click', exportCsv);
}

// ---------------------------------------------------------------- autoset (Python autoset)

function startAutoset() {
  const settings = app.store.settings;
  settings.channels.forEach((channel) => Object.assign(channel, { on: true, offset: 0 }));
  Object.assign(settings.trigger, { sweep: SWEEP_AUTO, position: 0.5 });
  settings.rateIndex = SAMPLING_RATES.indexOf(AUTOSET_RATE);
  settings.peak = true;
  app.running = true;
  app.single = false;
  app.autoset = { tries: 0, rateLimit: SAMPLING_RATES.length, settleUntil: performance.now() + AUTOSET_SETTLE_MS, levels: [0, 0], amplitudes: [0, 0] };
  schedulePush(ALL_GROUPS);
  afterChange();
}

function autosetRate(run, slot, amplitude) {
  const settings = app.store.settings;
  let changed = false;
  if (slot.periodNum > 1 && amplitude > 20) {
    const index = rateIndexForPeriod(slot.timeSum / slot.periodNum / 1e8);
    changed = index !== settings.rateIndex && index < run.rateLimit;
    if (changed) {
      settings.rateIndex = index;
      run.rateLimit = index;
    }
  }
  return changed;
}

function autosetOneChannel(run, index) {
  const channel = app.store.settings.channels[index];
  const slot = app.slots[index];
  const { low, high } = frameMinMax(slot);
  const result = autosetChannel(channel.rangeIndex, channel.offset, low, high);
  let changed = false;
  if (result.off) {
    const otherChannelOn = app.store.settings.channels[1 - index].on;
    channel.on = !otherChannelOn;
    changed = otherChannelOn;
  } else {
    changed = result.rangeIndex !== channel.rangeIndex;
    channel.rangeIndex = result.rangeIndex;
    run.amplitudes[index] = result.amplitude;
    run.levels[index] = result.level === null ? run.levels[index] : result.level;
    changed = autosetRate(run, slot, result.amplitude) || changed;
  }
  return changed;
}

function autosetStep() {
  const run = app.autoset;
  const now = performance.now();
  if (now >= run.settleUntil) {
    let changed = false;
    app.store.settings.channels.forEach((channel, index) => {
      if (channel.on && app.slots[index].present) {
        changed = autosetOneChannel(run, index) || changed;
      }
    });
    run.tries++;
    run.settleUntil = now + AUTOSET_SETTLE_MS;
    if (changed && run.tries < AUTOSET_MAX_TRIES) {
      schedulePush(ALL_GROUPS);
    } else {
      finishAutoset(run);
    }
    afterChange();
  }
}

function finishAutoset(run) {
  const settings = app.store.settings;
  const secondIsStronger = run.amplitudes[1] > run.amplitudes[0] && settings.channels[1].on;
  const strongest = secondIsStronger ? 1 : CH1;
  Object.assign(settings.trigger, { source: strongest, fall: false, levelDiv: (run.levels[strongest] * 10) / ADC_RANGE });
  settings.peak = false;
  app.autoset = null;
  schedulePush(ALL_GROUPS);
}

// ---------------------------------------------------------------- frames

function consumeLatest() {
  const message = app.latest;
  const settings = app.store.settings;
  const roll = samplingFor(settings.rateIndex).roll;
  app.latest = null;
  app.slots.forEach((slot) => { slot.present = false; });
  for (let index = 0; index < frameCount(message.byteLength); index++) {
    const slot = parseFrameInto(message, index, roll, app.slots);
    const channel = settings.channels[slot.channel];
    if (channel.coupling === GND) {
      forceGround(slot, channel);
    }
  }
  if (app.autoset) {
    autosetStep();
  } else if (isOneShot(settings, app.single)) {
    app.running = false;
    app.single = false;
    refreshState();
  }
  app.dirty = true;
}

// ---------------------------------------------------------------- drawing: shared

function pixelRatio() {
  return window.devicePixelRatio || 1;
}

function resizeCanvases() {
  const ratio = pixelRatio();
  const width = Math.round(traceCanvas.clientWidth * ratio);
  const height = Math.round(traceCanvas.clientHeight * ratio);
  [traceCanvas, gridCanvas].forEach((canvas) => {
    canvas.width = width;
    canvas.height = height;
  });
  app.dirty = true;
  app.gridDirty = true;
}

function drawGrid() {
  const { width, height } = gridCanvas;
  const ratio = pixelRatio();
  gridContext.clearRect(0, 0, width, height);
  gridContext.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const middle = i === 5;
    gridContext.strokeStyle = middle ? '#3b434f' : '#20252c';
    gridContext.beginPath();
    gridContext.moveTo(Math.round((i * width) / 10) + 0.5, 0);
    gridContext.lineTo(Math.round((i * width) / 10) + 0.5, height);
    gridContext.moveTo(0, Math.round((i * height) / 10) + 0.5);
    gridContext.lineTo(width, Math.round((i * height) / 10) + 0.5);
    gridContext.stroke();
  }
  drawTicks(gridContext, width, height, ratio);
  app.gridDirty = false;
}

function drawTicks(context, width, height, ratio) {
  context.strokeStyle = '#3b434f';
  context.beginPath();
  for (let i = 0; i < 50; i++) {
    const x = (i * width) / 50;
    const y = (i * height) / 50;
    context.moveTo(x, height / 2 - 3 * ratio);
    context.lineTo(x, height / 2 + 3 * ratio);
    context.moveTo(width / 2 - 3 * ratio, y);
    context.lineTo(width / 2 + 3 * ratio, y);
  }
  context.stroke();
}

function sampleY(sample, height) {
  return height * (0.5 - sample / ADC_RANGE);
}

function strokePath(context, color) {
  context.strokeStyle = color;
  context.lineWidth = 1.5 * pixelRatio();
  context.lineJoin = 'round';
  context.stroke();
}

// ---------------------------------------------------------------- drawing: time view

function addColumn(context, samples, start, end, x, height, isFirst) {
  let low = samples[start];
  let high = low;
  for (let i = start + 1; i < end; i++) {
    low = Math.min(low, samples[i]);
    high = Math.max(high, samples[i]);
  }
  if (isFirst) {
    context.moveTo(x, sampleY(samples[start], height));
  } else {
    context.lineTo(x, sampleY(samples[start], height));
  }
  context.lineTo(x, sampleY(low, height));
  context.lineTo(x, sampleY(high, height));
  context.lineTo(x, sampleY(samples[end - 1], height));
}

function tracePolyline(context, slot, width, height) {
  const step = width / SAMPLES;
  context.moveTo((slot.first + 0.5) * step, sampleY(slot.samples[slot.first], height));
  for (let i = slot.first + 1; i < SAMPLES; i++) {
    context.lineTo((i + 0.5) * step, sampleY(slot.samples[i], height));
  }
}

function traceColumns(context, slot, width, height) {
  const perColumn = SAMPLES / width;
  const firstColumn = Math.floor(slot.first / perColumn);
  for (let column = firstColumn; column < width; column++) {
    const start = Math.max(slot.first, Math.floor(column * perColumn));
    const end = Math.min(SAMPLES, Math.floor((column + 1) * perColumn));
    if (end > start) {
      addColumn(context, slot.samples, start, end, column + 0.5, height, column === firstColumn);
    }
  }
}

function drawTrace(slot, index, width, height) {
  traceContext.beginPath();
  if (SAMPLES / width < 2) {
    tracePolyline(traceContext, slot, width, height);
  } else {
    traceColumns(traceContext, slot, width, height);
  }
  strokePath(traceContext, TRACE_COLORS[index]);
}

function drawTag(x, y, direction, color, label) {
  const size = 7 * pixelRatio();
  traceContext.fillStyle = color;
  traceContext.beginPath();
  traceContext.moveTo(x, y);
  traceContext.lineTo(x + direction * size * 1.6, y - size);
  traceContext.lineTo(x + direction * size * 1.6, y + size);
  traceContext.closePath();
  traceContext.fill();
  traceContext.fillStyle = '#000';
  traceContext.font = `${Math.round(9 * pixelRatio())}px sans-serif`;
  traceContext.textAlign = 'center';
  traceContext.textBaseline = 'middle';
  traceContext.fillText(label, x + direction * size * 1.1, y);
}

function drawPositionMarker(x) {
  const size = 7 * pixelRatio();
  traceContext.fillStyle = '#ffffff';
  traceContext.beginPath();
  traceContext.moveTo(x, size * 1.6);
  traceContext.lineTo(x - size, 0);
  traceContext.lineTo(x + size, 0);
  traceContext.closePath();
  traceContext.fill();
}

function drawDashedLine(x1, y1, x2, y2, color) {
  traceContext.setLineDash([4 * pixelRatio(), 6 * pixelRatio()]);
  traceContext.beginPath();
  traceContext.moveTo(x1, y1);
  traceContext.lineTo(x2, y2);
  strokePath(traceContext, color);
  traceContext.setLineDash([]);
}

function drawGroundMarkers(width, height) {
  const { channels } = app.store.settings;
  channels.forEach((channel, index) => {
    if (channel.on) {
      drawTag(0, height * (0.5 - channel.offset), 1, TRACE_COLORS[index], String(index + 1));
    }
  });
}

function drawTriggerMarkers(width, height) {
  const settings = app.store.settings;
  const { source, levelDiv } = settings.trigger;
  const x = displayedTriggerPosition(settings) * width;
  drawDashedLine(x, 0, x, height, '#6b7480');
  drawPositionMarker(x);
  if (source !== EXT) {
    const y = height * (0.5 - settings.channels[source].offset - levelDiv / 10);
    drawDashedLine(0, y, width, y, TRACE_COLORS[source] + '99');
    drawTag(width, clip(y, 0, height), -1, TRACE_COLORS[source], 'T');
  }
}

function cursorEnabledAxes() {
  const ui = app.store.ui;
  return { vertical: ui.cursorsV && ui.view === 'time', horizontal: ui.cursorsT && ui.view === 'time' };
}

function cursorsActive() {
  const axes = cursorEnabledAxes();
  return axes.vertical || axes.horizontal;
}

function drawCursors(width, height) {
  const ui = app.store.ui;
  const axes = cursorEnabledAxes();
  if (axes.vertical) {
    ui.vCursors.forEach((fraction) => drawDashedLine(0, height * (1 - fraction), width, height * (1 - fraction), '#ff7ad9'));
  }
  if (axes.horizontal) {
    ui.tCursors.forEach((fraction) => drawDashedLine(width * fraction, 0, width * fraction, height, '#9be26a'));
  }
}

function drawChannelGuide(width, height) {
  const drag = app.handleDrag;
  if (drag && drag.kind === 'offset') {
    const y = height * (0.5 - app.store.settings.channels[drag.index].offset);
    drawDashedLine(0, y, width, y, TRACE_COLORS[drag.index]);
  }
}

function drawTimeView(width, height) {
  app.slots.forEach((slot, index) => {
    if (slot.present && app.store.settings.channels[index].on) {
      drawTrace(slot, index, width, height);
    }
  });
  drawGroundMarkers(width, height);
  drawTriggerMarkers(width, height);
  drawChannelGuide(width, height);
  drawCursors(width, height);
}

// ---------------------------------------------------------------- drawing: XY view

function drawXyView(width, height) {
  const [slotX, slotY] = app.slots;
  const [channelX, channelY] = app.store.settings.channels;
  if (slotX.present && slotY.present) {
    const first = Math.max(slotX.first, slotY.first);
    traceContext.beginPath();
    for (let i = first; i < SAMPLES; i++) {
      const x = width * (slotX.samples[i] / ADC_RANGE - channelX.offset + 0.5);
      const y = height * (0.5 + channelY.offset - slotY.samples[i] / ADC_RANGE);
      if (i === first) {
        traceContext.moveTo(x, y);
      } else {
        traceContext.lineTo(x, y);
      }
    }
    strokePath(traceContext, TRACE_COLORS[0]);
  }
}

// ---------------------------------------------------------------- drawing: FFT view

function createFftState() {
  return {
    work: { real: new Float64Array(MAX_FFT_SIZE), imag: new Float64Array(MAX_FFT_SIZE) },
    plans: new Map(),
    windows: new Map(),
    db: [new Float32Array(MAX_FFT_SIZE / 2 + 1), new Float32Array(MAX_FFT_SIZE / 2 + 1)],
    sizes: [0, 0],
    top: 20,
  };
}

function cached(map, size, make) {
  if (!map.has(size)) {
    map.set(size, make(size));
  }
  return map.get(size);
}

function updateSpectrum(index) {
  const fft = app.fft;
  const slot = app.slots[index];
  const size = slot.present ? fftSizeFor(SAMPLES - slot.first) : 0;
  fft.sizes[index] = 0;
  if (size >= MIN_FFT_SIZE) {
    const plan = cached(fft.plans, size, createFft);
    const window = cached(fft.windows, size, hannWindow);
    fft.sizes[index] = computeSpectrum(plan, window, slot, app.store.settings.channels[index], fft.work, fft.db[index]);
  }
}

function spectrumPeak(index) {
  const { db, sizes } = app.fft;
  let peak = 2;
  for (let bin = 3; bin <= sizes[index] / 2; bin++) {
    peak = db[index][bin] > db[index][peak] ? bin : peak;
  }
  return peak;
}

function drawSpectrum(index, width, height) {
  const { db, sizes, top } = app.fft;
  const bins = sizes[index] / 2;
  traceContext.beginPath();
  for (let bin = 0; bin <= bins; bin++) {
    const y = clip(((top - db[index][bin]) / FFT_SPAN_DB) * height, 0, height);
    if (bin === 0) {
      traceContext.moveTo(0, y);
    } else {
      traceContext.lineTo((bin / bins) * width, y);
    }
  }
  strokePath(traceContext, TRACE_COLORS[index]);
}

function drawFftView(width, height) {
  const fft = app.fft;
  let maxDb = -FFT_SPAN_DB;
  [0, 1].forEach((index) => {
    updateSpectrum(index);
    if (fft.sizes[index] > 0 && app.store.settings.channels[index].on) {
      maxDb = Math.max(maxDb, fft.db[index][spectrumPeak(index)]);
    }
  });
  fft.top = Math.ceil((maxDb + 5) / 10) * 10;
  [0, 1].forEach((index) => {
    if (fft.sizes[index] > 0 && app.store.settings.channels[index].on) {
      drawSpectrum(index, width, height);
    }
  });
}

// ---------------------------------------------------------------- render loop

function render() {
  const { width, height } = traceCanvas;
  const view = app.store.ui.view;
  layoutHandles();
  traceContext.clearRect(0, 0, width, height);
  if (view === 'time') {
    drawTimeView(width, height);
  } else if (view === 'fft') {
    drawFftView(width, height);
  } else {
    drawXyView(width, height);
  }
}

function frameLoop(now) {
  if (app.latest) {
    consumeLatest();
  }
  if (app.gridDirty) {
    drawGrid();
  }
  if (app.dirty) {
    app.dirty = false;
    render();
  }
  if (now - app.lastReadout >= READOUT_MS) {
    app.lastReadout = now;
    updateReadouts();
  }
  requestAnimationFrame(frameLoop);
}

// ---------------------------------------------------------------- readouts

function buildMeasureTable() {
  const table = $('measures');
  const rows = ['Frequency', 'Vpp', 'Vmax', 'Vmin', 'Vavg', 'Vrms'];
  ['', 'CH1', 'CH2'].forEach((title, column) => {
    const cell = document.createElement('div');
    cell.textContent = title;
    cell.className = column === 0 ? 'label' : `value c${column - 1}`;
    table.appendChild(cell);
  });
  rows.forEach((row) => {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = row;
    table.appendChild(label);
    [0, 1].forEach((channel) => {
      const cell = document.createElement('div');
      cell.className = `value c${channel}`;
      table.appendChild(cell);
      app.measureCells.push(cell);
    });
  });
}

function showMeasures(index) {
  const slot = app.slots[index];
  const on = slot.present && app.store.settings.channels[index].on;
  const result = on ? measure(slot, app.store.settings.channels[index]) : null;
  const values = result
    ? [result.frequency > 0 ? formatSi(result.frequency, 'Hz') : '-', ...[result.vpp, result.vmax, result.vmin, result.vavg, result.vrms].map((v) => formatSi(v, 'V'))]
    : ['-', '-', '-', '-', '-', '-'];
  values.forEach((text, row) => {
    app.measureCells[row * 2 + index].textContent = text;
  });
}

function updateScaleStrip() {
  const settings = app.store.settings;
  const sampling = samplingFor(settings.rateIndex);
  settings.channels.forEach((channel, index) => {
    const coupling = ['AC', 'DC', 'GND soft'][channel.coupling];
    $(`scale-${index}`).textContent = channel.on ? `CH${index + 1} ${rangeLabel(channel.rangeIndex, channel.probe)} ${coupling}` : '';
  });
  $('scale-time').textContent = `${formatSi(timeRangeSeconds(settings.rateIndex) / 10, 's')}/div`;
  $('sample-info').textContent = `${formatSi(sampling.rate, 'S/s')}${sampling.roll ? ' roll' : ''}${settings.peak ? ' peak' : ''}`;
}

function cursorText() {
  const settings = app.store.settings;
  const ui = app.store.ui;
  const axes = cursorEnabledAxes();
  const parts = [];
  if (axes.vertical) {
    const channel = settings.channels[ui.cursorChannel];
    const [a, b] = ui.vCursors.map((fraction) => screenToVolts(fraction, channel));
    parts.push(`CH${ui.cursorChannel + 1} ${formatSi(a, 'V')} / ${formatSi(b, 'V')}  dV ${formatSi(b - a, 'V')}`);
  }
  if (axes.horizontal) {
    const sampling = samplingFor(settings.rateIndex);
    const position = displayedTriggerPosition(settings);
    const [a, b] = ui.tCursors.map((fraction) => sampleTimeSeconds(fraction * SAMPLES, sampling.rate, position));
    const delta = Math.abs(b - a);
    parts.push(`dT ${formatSi(delta, 's')}${delta > 0 ? ` (${formatSi(1 / delta, 'Hz')})` : ''}`);
  }
  return parts.join('  |  ');
}

function fftText() {
  const settings = app.store.settings;
  const rate = samplingFor(settings.rateIndex).rate;
  const parts = [`0 - ${formatSi(rate / 2, 'Hz')}, ${formatSi(rate / 20, 'Hz')}/div, ${app.fft.top} dBV top, 10 dB/div`];
  [0, 1].forEach((index) => {
    const size = app.fft.sizes[index];
    if (size > 0 && settings.channels[index].on) {
      const peak = spectrumPeak(index);
      parts.push(`CH${index + 1} peak ${formatSi((peak * rate) / size, 'Hz')} ${app.fft.db[index][peak].toFixed(1)} dBV`);
    }
  });
  return parts.join('  |  ');
}

function updateReadouts() {
  const view = app.store.ui.view;
  showMeasures(0);
  showMeasures(1);
  updateScaleStrip();
  $('info').textContent = infoText(view);
}

function infoText(view) {
  let text = cursorText();
  if (view === 'fft') {
    text = fftText();
  } else if (view === 'xy') {
    text = 'X: CH1, Y: CH2';
  }
  return text;
}

function updateStats() {
  const stats = app.stats;
  const rtt = stats.roundTrip === null ? '?' : stats.roundTrip.toFixed(0);
  $('stats').textContent = `${stats.messages} refreshes/s, ${(stats.bytes / 1024).toFixed(0)} KB/s, ${stats.skipped} skipped, round trip ${rtt} ms`;
  stats.messages = 0;
  stats.bytes = 0;
  stats.skipped = 0;
  send(String(performance.now()));
}

// ---------------------------------------------------------------- cursor dragging

function pointerPosition(event) {
  const rect = traceCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
}

function nearestCursor(position) {
  const ui = app.store.ui;
  const axes = cursorEnabledAxes();
  let best = null;
  let bestDistance = CURSOR_GRAB_PX;
  const consider = (list, horizontal, distanceOf) => {
    list.forEach((fraction, index) => {
      const distance = distanceOf(fraction);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { list, index, horizontal };
      }
    });
  };
  if (axes.vertical) {
    consider(ui.vCursors, false, (fraction) => Math.abs(position.height * (1 - fraction) - position.y));
  }
  if (axes.horizontal) {
    consider(ui.tCursors, true, (fraction) => Math.abs(position.width * fraction - position.x));
  }
  return best;
}

function onPointerDown(event) {
  app.drag = nearestCursor(pointerPosition(event));
  if (app.drag) {
    traceCanvas.setPointerCapture(event.pointerId);
  }
}

function onPointerMove(event) {
  if (app.drag) {
    const position = pointerPosition(event);
    const fraction = app.drag.horizontal ? position.x / position.width : 1 - position.y / position.height;
    app.drag.list[app.drag.index] = clip(fraction, 0, 1);
    app.dirty = true;
    $('info').textContent = cursorText();
  }
}

function onPointerUp() {
  if (app.drag) {
    app.drag = null;
    saveStore();
  }
}

function bindCanvas() {
  traceCanvas.addEventListener('pointerdown', onPointerDown);
  traceCanvas.addEventListener('pointermove', onPointerMove);
  traceCanvas.addEventListener('pointerup', onPointerUp);
  traceCanvas.addEventListener('pointercancel', onPointerUp);
  new ResizeObserver(resizeCanvases).observe(traceCanvas);
}

// ---------------------------------------------------------------- handle dragging

// Position of a handle as a fraction of the plot: from the left for the trigger position, else from the top.
function handleFraction(kind, index) {
  const { channels, trigger } = app.store.settings;
  let fraction = 0.5 - channels[index].offset;
  if (kind === 'level') {
    fraction = clip(0.5 - channels[trigger.source].offset - trigger.levelDiv / 10, 0, 1);
  } else if (kind === 'position') {
    fraction = trigger.position;
  }
  return fraction;
}

function handleVisible(kind, index) {
  const settings = app.store.settings;
  let visible = app.store.ui.view === 'time';
  if (kind === 'level') {
    visible = visible && settings.trigger.source !== EXT;
  } else if (kind === 'position') {
    visible = visible && !samplingFor(settings.rateIndex).roll;
  } else {
    visible = visible && settings.channels[index].on;
  }
  return visible;
}

function handleIdentity(element) {
  return { kind: element.dataset.handle, index: Number(element.dataset.channel || 0) };
}

function placeHandle(element, kind, index) {
  const horizontal = kind === 'position';
  const extent = horizontal ? traceCanvas.clientWidth : traceCanvas.clientHeight;
  const size = horizontal ? element.offsetWidth : element.offsetHeight;
  const start = clip(handleFraction(kind, index) * extent - size / 2, 0, extent - size);
  element.style.transform = horizontal ? `translateX(${start}px)` : `translateY(${start}px)`;
  element.style.zIndex = kind === 'offset' && index === app.activeChannel ? '2' : '1';
}

function layoutHandles() {
  document.querySelectorAll('.handle').forEach((element) => {
    const { kind, index } = handleIdentity(element);
    element.hidden = !handleVisible(kind, index);
    if (!element.hidden) {
      placeHandle(element, kind, index);
    }
  });
}

function dragPath(drag) {
  const paths = {
    level: 'settings.trigger.levelDiv',
    position: 'settings.trigger.position',
    offset: `settings.channels.${drag.index}.offset`,
  };
  return paths[drag.kind];
}

function dragValue(drag, fraction) {
  const settings = app.store.settings;
  let value = offsetAtScreen(fraction);
  if (drag.kind === 'level') {
    value = levelDivAtScreen(fraction, settings.channels[settings.trigger.source].offset);
  } else if (drag.kind === 'position') {
    value = positionAtScreen(fraction);
  }
  return value;
}

function dragReadoutText(drag) {
  const settings = app.store.settings;
  const channel = settings.channels[drag.kind === 'level' ? settings.trigger.source : drag.index];
  let text = `CH${drag.index + 1} ${formatSi(channel.offset * fullScaleVolts(channel), 'V')}`;
  if (drag.kind === 'level') {
    text = `Trigger ${formatSi(settings.trigger.levelDiv * voltsPerDivision(channel), 'V')}`;
  } else if (drag.kind === 'position') {
    text = `Trigger ${formatSi(settings.trigger.position * timeRangeSeconds(settings.rateIndex), 's')} from left`;
  }
  return text;
}

function readoutPlacement(drag) {
  const width = traceCanvas.clientWidth;
  const height = traceCanvas.clientHeight;
  const fraction = handleFraction(drag.kind, drag.index);
  const placements = {
    level: { left: 'auto', right: '50px', top: `${clip(fraction * height, 14, height - 14)}px`, transform: 'translateY(-50%)' },
    offset: { left: '50px', right: 'auto', top: `${clip(fraction * height, 14, height - 14)}px`, transform: 'translateY(-50%)' },
    position: { left: `${clip(fraction * width, 70, width - 70)}px`, right: 'auto', top: '50px', transform: 'translateX(-50%)' },
  };
  return placements[drag.kind];
}

function showDragReadout(drag) {
  const readout = $('drag-readout');
  readout.textContent = dragReadoutText(drag);
  Object.assign(readout.style, readoutPlacement(drag));
  readout.hidden = false;
}

function pointerFraction(event, kind) {
  const position = pointerPosition(event);
  return kind === 'position' ? position.x / position.width : position.y / position.height;
}

function onHandleDown(event) {
  if (!app.handleDrag) {
    const element = event.currentTarget;
    const { kind, index } = handleIdentity(element);
    element.setPointerCapture(event.pointerId);
    app.activeChannel = kind === 'offset' ? index : app.activeChannel;
    app.handleDrag = { kind, index, moved: false, grab: pointerFraction(event, kind) - handleFraction(kind, index) };
    event.preventDefault();
  }
}

function onHandleMove(event) {
  const drag = app.handleDrag;
  if (drag) {
    const path = dragPath(drag);
    const value = dragValue(drag, pointerFraction(event, drag.kind) - drag.grab);
    if (value !== getPath(path)) {
      drag.moved = true;
      applyChange(path, value, DRAG_PUSH_MS);
    }
    showDragReadout(drag);
  }
}

function onHandleUp() {
  const drag = app.handleDrag;
  if (drag) {
    app.handleDrag = null;
    $('drag-readout').hidden = true;
    if (drag.moved) {
      schedulePush(groupsFor(dragPath(drag)));
      flushNow();
    }
    app.dirty = true;
  }
}

function bindHandles() {
  document.querySelectorAll('.handle').forEach((element) => {
    element.addEventListener('pointerdown', onHandleDown);
    element.addEventListener('pointermove', onHandleMove);
    element.addEventListener('pointerup', onHandleUp);
    element.addEventListener('pointercancel', onHandleUp);
  });
}

// ---------------------------------------------------------------- start

function start() {
  const saved = loadSaved();
  app.store.settings = restoreSettings(saved && saved.settings);
  app.store.ui = restoreUi(saved && saved.ui);
  fillRangeOptions();
  buildMeasureTable();
  bindControls();
  bindActions();
  bindCanvas();
  bindHandles();
  syncControls();
  resizeCanvases();
  connect();
  setInterval(updateStats, STATS_MS);
  requestAnimationFrame(frameLoop);
}

start();
