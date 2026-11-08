import {
  ADC_RANGE, CH1, GND, MODE_STOPPED, SAMPLING_RATES, SWEEP_AUTO,
  autosetChannel, autosetPeriodSeconds, buildAllWrites, buildChannelWrites, buildCsv, buildForceTriggerWrites, buildSamplingWrites,
  buildTriggerWrites, captureSetup, channelMask, clip, createFrameSlot, displayedTriggerPosition, encodeMode, encodeWrites,
  fidelityLevel, forceGround, frameCount, frameMinMax, frequencyHz, isSingleCapture, isSingleFilling, levelDivAtMidpoint,
  levelDivForRange, measure, parseFlash, parseFrameInto, rateIndexForPeriod, readSequence, runModeFor, sampleScale,
  samplingFor, timeRangeSeconds, triggerShift,
} from '../scope_logic.js';
import { reactive } from './owl.js';
import { getPath, saveStore, setPath } from './store.js';

const RECONNECT_MS = 1000;
const FLASH_RETRY_MS = 3000;
const STATS_MS = 1000;
const READOUT_MS = 250;
const PUSH_DELAY_MS = 30;
const MIN_TRIGGER_WAIT_MS = 1000;
const AUTOSET_SETTLE_MS = 300;
const AUTOSET_MAX_TRIES = 10;
const AUTOSET_RATE = 25e3;
const ALL_GROUPS = ['sampling', 'channel0', 'channel1', 'trigger'];
export const RUN = 'run';
export const STOP = 'stop';
export const SINGLE = 'single';

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

function parseEvent(text) {
  let event = null;
  try {
    event = JSON.parse(text);
  } catch (error) {
    event = null;
  }
  return event;
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

// The link to the board: settings pushes, acquisition control, autoset and incoming frames.
// `status` is reactive for the components; frames and slots stay plain for the drawing loop.
export class ScopeSession {
  constructor(store) {
    this.store = store;
    this.status = reactive({
      link: 'offline',
      acquire: RUN,
      singleCount: 0,
      singleFilling: false,
      autosetRunning: false,
      // Name of the acquisition state, see refreshState().
      state: 'offline',
      // measure() results for CH1 and CH2, null when the channel shows nothing.
      measures: [null, null],
      fidelity: null,
      // Written by the screen in the FFT view: { top, rate, peaks: [{ frequency, db } | null, ...] }.
      fft: null,
      statsText: '-',
    });
    this.flash = null;
    this.capture = null;
    this.slots = [createFrameSlot(), createFrameSlot()];
    this.latest = null;
    this.lastFrameAt = 0;
    this.socket = null;
    this.generation = 0;
    this.pending = new Set();
    this.pushTimer = 0;
    this.autosetRun = null;
    // Set when the screen needs a redraw; the screen clears it.
    this.dirty = true;
    this.stats = { messages: 0, bytes: 0, skipped: 0, lastSequence: null, roundTrip: null };
  }

  start() {
    this.connect();
    setInterval(() => this.updateStats(), STATS_MS);
    setInterval(() => this.updateReadouts(), READOUT_MS);
  }

  // ------------------------------------------------------------ settings changes

  get(path) {
    return getPath(this.store, path);
  }

  // Paths start with settings., ui. or display.; only settings go to the board.
  set(path, value, delay = PUSH_DELAY_MS) {
    this.keepTriggerVolts(path, value);
    setPath(this.store, path, value);
    if (path.startsWith('settings.')) {
      this.schedulePush(groupsFor(path), delay);
    }
    this.afterChange();
  }

  step(path, delta, count) {
    this.set(path, clip(this.get(path) + delta, 0, count - 1));
  }

  // After a drag that pushed with a longer delay: send the final value at once.
  commit(path) {
    this.schedulePush(groupsFor(path));
    this.flushNow();
  }

  save() {
    saveStore(this.store);
  }

  markDirty() {
    this.dirty = true;
  }

  keepTriggerVolts(path, rangeIndex) {
    const { channels, trigger } = this.store.settings;
    if (path === `settings.channels.${trigger.source}.rangeIndex`) {
      trigger.levelDiv = levelDivForRange(trigger.levelDiv, channels[trigger.source].rangeIndex, rangeIndex);
    }
  }

  afterChange() {
    this.save();
    this.refreshState();
    this.dirty = true;
  }

  // ------------------------------------------------------------ connection

  send(data) {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }

  get singleArmed() {
    return this.status.acquire === SINGLE;
  }

  sendMode() {
    const settings = this.store.settings;
    const mode = this.status.acquire === STOP ? MODE_STOPPED : runModeFor(settings, this.singleArmed);
    this.send(encodeMode(channelMask(settings), mode));
  }

  sendWrites(writes) {
    encodeWrites(writes).forEach((message) => this.send(message));
  }

  writesForGroups(groups) {
    const settings = this.store.settings;
    const calibration = this.flash.calibration;
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
      writes.push(...buildTriggerWrites(settings, this.singleArmed));
    }
    return writes;
  }

  flushPending() {
    const groups = this.pending;
    this.pending = new Set();
    this.pushTimer = 0;
    if (this.flash) {
      this.sendWrites(this.writesForGroups(groups));
      this.sendMode();
    }
  }

  schedulePush(groups, delay = PUSH_DELAY_MS) {
    groups.forEach((group) => this.pending.add(group));
    if (this.pushTimer === 0) {
      this.pushTimer = setTimeout(() => this.flushPending(), delay);
    }
  }

  flushNow() {
    clearTimeout(this.pushTimer);
    this.flushPending();
  }

  pushEverything() {
    this.sendWrites(buildAllWrites(this.store.settings, this.flash.calibration, this.singleArmed));
    this.sendMode();
  }

  setLink(link) {
    this.status.link = link;
    this.refreshState();
  }

  async loadFlash(generation) {
    let flash = null;
    try {
      const response = await fetch('/flash');
      flash = response.ok ? parseFlash(await response.arrayBuffer()) : null;
    } catch (error) {
      flash = null;
    }
    if (generation === this.generation) {
      this.onFlashResult(flash, generation);
    }
  }

  onFlashResult(flash, generation) {
    this.flash = flash;
    if (flash) {
      this.setLink('ready');
      this.pushEverything();
    } else {
      this.setLink('waiting');
      setTimeout(() => this.retryFlash(generation), FLASH_RETRY_MS);
    }
  }

  retryFlash(generation) {
    if (this.generation === generation && this.status.link === 'waiting') {
      this.loadFlash(generation);
    }
  }

  startSession() {
    this.generation++;
    this.flash = null;
    this.setLink('waiting');
    this.loadFlash(this.generation);
  }

  onText(text) {
    const event = text.startsWith('{') ? parseEvent(text) : null;
    if (event && event.event === 'scope_ready') {
      this.startSession();
    } else if (Number.isFinite(Number(text))) {
      this.stats.roundTrip = performance.now() - Number(text);
    }
  }

  // Frames from before a Single press are still on their way: only the board's own capture ends a single.
  // In roll mode the frames after the trigger show the screen filling up.
  acceptsFrame(message) {
    const singleFrame = isSingleFilling(message) || isSingleCapture(message);
    return this.status.acquire === RUN || (this.singleArmed && singleFrame);
  }

  onBinary(message) {
    const stats = this.stats;
    const sequence = readSequence(message);
    if (stats.lastSequence !== null) {
      stats.skipped += Math.max(0, ((sequence - stats.lastSequence - 1) >>> 0));
    }
    stats.lastSequence = sequence;
    stats.messages++;
    stats.bytes += message.byteLength;
    if (this.acceptsFrame(message)) {
      this.latest = message;
      this.lastFrameAt = performance.now();
    }
  }

  onMessage(event) {
    if (typeof event.data === 'string') {
      this.onText(event.data);
    } else {
      this.onBinary(event.data);
    }
  }

  onClose() {
    this.generation++;
    this.stats.lastSequence = null;
    this.setLink('offline');
    setTimeout(() => this.connect(), RECONNECT_MS);
  }

  connect() {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.startSession();
    socket.onmessage = (event) => this.onMessage(event);
    socket.onclose = () => this.onClose();
    this.socket = socket;
  }

  // ------------------------------------------------------------ acquisition state

  framesAreFresh() {
    const sweepMs = 2000 * timeRangeSeconds(this.store.settings.rateIndex);
    return performance.now() - this.lastFrameAt < Math.max(MIN_TRIGGER_WAIT_MS, sweepMs);
  }

  runningState() {
    const settings = this.store.settings;
    let name = this.framesAreFresh() ? 'triggered' : 'awaiting';
    if (samplingFor(settings.rateIndex).roll) {
      name = 'roll';
    } else if (settings.trigger.sweep === SWEEP_AUTO) {
      name = 'auto';
    }
    return name;
  }

  acquisitionState() {
    const status = this.status;
    let name = status.singleCount > 0 ? 'captured' : 'stopped';
    if (status.autosetRunning) {
      name = 'autoset';
    } else if (status.acquire === RUN) {
      name = this.runningState();
    } else if (this.singleArmed) {
      name = status.singleFilling ? 'filling' : 'armed';
    }
    return name;
  }

  // One of offline, connecting, autoset, auto, roll, triggered, awaiting, armed, filling, stopped, captured.
  refreshState() {
    const link = this.status.link;
    let name = link === 'offline' ? 'offline' : 'connecting';
    if (link === 'ready') {
      name = this.acquisitionState();
    }
    this.status.state = name;
  }

  // ------------------------------------------------------------ actions

  // Run and Single rewrite the trigger: the Once sweep bits belong to a single only.
  setAcquire(acquire) {
    const status = this.status;
    status.acquire = acquire;
    status.singleCount = acquire === RUN ? 0 : status.singleCount;
    status.singleFilling = false;
    this.latest = null;
    if (this.flash && acquire === STOP) {
      this.sendMode();
    } else if (this.flash) {
      this.schedulePush(['trigger']);
    }
    this.refreshState();
  }

  toggleRun() {
    this.setAcquire(this.status.acquire === RUN ? STOP : RUN);
  }

  single() {
    this.setAcquire(SINGLE);
  }

  forceTrigger() {
    this.sendWrites(buildForceTriggerWrites());
  }

  setLevelToMiddle() {
    const settings = this.store.settings;
    const source = settings.trigger.source;
    const slot = this.slots[source];
    if (slot && slot.present) {
      const { low, high } = frameMinMax(slot);
      const level = levelDivAtMidpoint(low, high, this.capture.channels[source], settings.channels[source]);
      this.set('settings.trigger.levelDiv', level);
    }
  }

  exportCsv() {
    const columns = [];
    this.slots.forEach((slot, index) => {
      if (slot.present) {
        const { scale, shift } = sampleScale(this.capture.channels[index]);
        columns.push({ name: `CH${index + 1}`, samples: slot.samples, first: slot.first, scale, shift });
      }
    });
    if (columns.length > 0) {
      const capture = this.capture;
      const text = buildCsv(columns, samplingFor(capture.rateIndex).rate, displayedTriggerPosition(capture));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(new Blob([text], { type: 'text/csv' }), `owon-${stamp}.csv`);
    }
  }

  // ------------------------------------------------------------ autoset (Python autoset)

  autoset() {
    const settings = this.store.settings;
    settings.channels.forEach((channel) => Object.assign(channel, { on: true, offset: 0 }));
    Object.assign(settings.trigger, { sweep: SWEEP_AUTO, position: 0.5 });
    settings.rateIndex = SAMPLING_RATES.indexOf(AUTOSET_RATE);
    settings.peak = true;
    Object.assign(this.status, { acquire: RUN, singleCount: 0, autosetRunning: true });
    this.autosetRun = {
      tries: 0,
      rateLimit: SAMPLING_RATES.length,
      settleUntil: performance.now() + AUTOSET_SETTLE_MS,
      levels: [0, 0],
      amplitudes: [0, 0],
    };
    this.schedulePush(ALL_GROUPS);
    this.afterChange();
  }

  autosetRate(run, slot, amplitude) {
    const settings = this.store.settings;
    let changed = false;
    const period = autosetPeriodSeconds(slot, samplingFor(settings.rateIndex).rate);
    if (period > 0 && amplitude > 20) {
      const index = rateIndexForPeriod(period);
      changed = index !== settings.rateIndex && index < run.rateLimit;
      if (changed) {
        settings.rateIndex = index;
        run.rateLimit = index;
      }
    }
    return changed;
  }

  autosetOneChannel(run, index) {
    const channels = this.store.settings.channels;
    const channel = channels[index];
    const slot = this.slots[index];
    const { low, high } = frameMinMax(slot);
    const result = autosetChannel(channel.rangeIndex, channel.offset, low, high);
    let changed = false;
    if (result.off) {
      const otherChannelOn = channels[1 - index].on;
      channel.on = !otherChannelOn;
      changed = otherChannelOn;
    } else {
      changed = result.rangeIndex !== channel.rangeIndex;
      channel.rangeIndex = result.rangeIndex;
      run.amplitudes[index] = result.amplitude;
      run.levels[index] = result.level === null ? run.levels[index] : result.level;
      changed = this.autosetRate(run, slot, result.amplitude) || changed;
    }
    return changed;
  }

  autosetStep() {
    const run = this.autosetRun;
    const now = performance.now();
    if (now >= run.settleUntil) {
      let changed = false;
      this.store.settings.channels.forEach((channel, index) => {
        if (channel.on && this.slots[index].present) {
          changed = this.autosetOneChannel(run, index) || changed;
        }
      });
      run.tries++;
      run.settleUntil = now + AUTOSET_SETTLE_MS;
      if (changed && run.tries < AUTOSET_MAX_TRIES) {
        this.schedulePush(ALL_GROUPS);
      } else {
        this.finishAutoset(run);
      }
      this.afterChange();
    }
  }

  finishAutoset(run) {
    const settings = this.store.settings;
    const secondIsStronger = run.amplitudes[1] > run.amplitudes[0] && settings.channels[1].on;
    const strongest = secondIsStronger ? 1 : CH1;
    const levelDiv = (run.levels[strongest] * 10) / ADC_RANGE;
    Object.assign(settings.trigger, { source: strongest, fall: false, levelDiv });
    settings.peak = false;
    this.autosetRun = null;
    this.status.autosetRunning = false;
    this.schedulePush(ALL_GROUPS);
  }

  // ------------------------------------------------------------ frames

  // Parses the newest frame into the slots, if one came in; returns true when it did.
  takeFrame() {
    const message = this.latest;
    if (message) {
      this.consume(message);
    }
    return message !== null;
  }

  consume(message) {
    const settings = this.store.settings;
    const roll = samplingFor(settings.rateIndex).roll;
    this.latest = null;
    this.slots.forEach((slot) => { slot.present = false; });
    this.capture = captureSetup(settings);
    for (let index = 0; index < frameCount(message.byteLength); index++) {
      const slot = parseFrameInto(message, index, roll, this.slots);
      const channel = settings.channels[slot.channel];
      if (channel.coupling === GND) {
        forceGround(slot, channel);
      }
    }
    this.capture.triggerShift = triggerShift(settings, this.slots);
    this.afterFrame(message);
    this.dirty = true;
  }

  afterFrame(message) {
    const status = this.status;
    if (this.autosetRun) {
      this.autosetStep();
    } else if (this.singleArmed && isSingleCapture(message)) {
      status.acquire = STOP;
      status.singleCount++;
      this.refreshState();
    } else if (this.singleArmed && !status.singleFilling) {
      status.singleFilling = true;
      this.refreshState();
    }
  }

  // ------------------------------------------------------------ readouts

  measureChannel(index) {
    const slot = this.slots[index];
    const shown = slot.present && this.store.settings.channels[index].on;
    return shown ? measure(slot, this.capture.channels[index], samplingFor(this.capture.rateIndex).rate) : null;
  }

  // The scope's counter or the samples, 0 if unknown.
  signalFrequency(index, result) {
    const slot = this.slots[index];
    return result ? Math.max(result.frequency, frequencyHz(slot.timeSum, slot.periodNum)) : 0;
  }

  // { level, ratio } when the trace has too few samples per period, else null.
  fidelity(frequency) {
    const rate = this.capture ? samplingFor(this.capture.rateIndex).rate : 0;
    const level = fidelityLevel(rate, frequency);
    return level ? { level, ratio: Number((rate / frequency).toPrecision(2)) } : null;
  }

  updateReadouts() {
    const measures = [0, 1].map((index) => this.measureChannel(index));
    const frequency = Math.max(...measures.map((result, index) => this.signalFrequency(index, result)));
    this.status.measures = measures;
    this.status.fidelity = this.fidelity(frequency);
    this.refreshState();
  }

  updateStats() {
    const stats = this.stats;
    const roundTrip = stats.roundTrip === null ? '?' : stats.roundTrip.toFixed(0);
    const kilobytes = (stats.bytes / 1024).toFixed(0);
    this.status.statsText =
      `${stats.messages} refreshes/s, ${kilobytes} KB/s, ${stats.skipped} skipped, round trip ${roundTrip} ms`;
    stats.messages = 0;
    stats.bytes = 0;
    stats.skipped = 0;
    this.send(String(performance.now()));
  }
}
