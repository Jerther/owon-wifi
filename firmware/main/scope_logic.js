// Pure scope logic ported from OWON-VDS1022/api/python/vds1022/vds1022.py.
// No DOM, no network: everything here is testable with node.

export const CH1 = 0;
export const CH2 = 1;
export const EXT = 2;
export const AC = 0;
export const DC = 1;
export const GND = 2;
export const SWEEP_AUTO = 0;
export const SWEEP_NORMAL = 1;
export const SWEEP_ONCE = 2;
export const MODE_STOPPED = 0;
export const MODE_FREE = 1;
export const MODE_TRIGGERED = 2;
export const MODE_SINGLE = 3;

export const VOLT_RANGES = [50e-3, 100e-3, 200e-3, 500e-3, 1, 2, 5, 10, 20, 50];
// The nominal 2.5 S/s entry is left out: the Python clamps it to 3 S/s (max(3, rate)).
export const SAMPLING_RATES = [
  5, 12.5, 25, 50, 125, 250, 500, 1.25e3, 2.5e3, 5e3, 12.5e3, 25e3, 50e3, 125e3, 250e3, 500e3,
  1.25e6, 2.5e6, 5e6, 12.5e6, 25e6, 50e6, 100e6,
];
export const PROBES = [1, 10, 100];
export const DIVISIONS = 10;
export const OFFSET_LIMIT = 0.45;
export const LEVEL_LIMIT_DIV = 5;
const LEVEL_STEP = 0.05;
const FRACTION_STEP = 0.01;

export const FRAME_SIZE = 5211;
export const SAMPLES = 5000;
export const ADC_SIZE = 5100;
export const ADC_MAX = 125;
export const ADC_MIN = -125;
export const ADC_RANGE = 250;
export const MAX_FFT_SIZE = 4096;
export const MAX_MESSAGE_SIZE = 512;
export const FLASH_SIZE = 2002;

const BASE_CLOCK = 100e6;
const ATTENUATION_THRESHOLD = 6;
const ROLLMODE_THRESHOLD = 2500;
const HTP_ERR = 11;
const HOLDOFF_100NS = 0x8002;
const EDGE_LEVEL_DISABLED = 0x807f;
const FREQ_REF_DEFAULT = 20;
const FRAME_HEADER_SIZE = 111;
const NON_ROLL_SKIP = 50;
const ROLL_SKIP = 100;
const SEQUENCE_SIZE = 4;
const SINGLE_CAPTURE_FLAG = 0x80000000;
const CMD_WRITE_REGISTERS = 0x01;
const CMD_SET_MODE = 0x02;
const FORCE_TRIGGER_VALUE = 3;

const REG = {
  multi: [0x06, 2],
  peak: [0x09, 1],
  roll: [0x0a, 1],
  forceTrigger: [0x0c, 1],
  trigger: [0x24, 2],
  timebase: [0x52, 4],
  suffixTrigger: [0x56, 4],
  prefixTrigger: [0x5a, 2],
  deepMemory: [0x5c, 2],
  channel: [[0x0111, 1], [0x0110, 1]],
  zeroOffset: [[0x010a, 2], [0x0108, 2]],
  voltGain: [[0x0116, 2], [0x0114, 2]],
  edgeLevel: [[0x2e, 2], [0x30, 2]],
  holdoff: [[0x26, 2], [0x2a, 2]],
  freqRef: [[0x4a, 1], [0x4b, 1]],
};

export function clip(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// Python's round(): halves go to the even neighbour.
export function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  let result = Math.round(value);
  if (diff === 0.5) {
    result = floor % 2 === 0 ? floor : floor + 1;
  }
  return result;
}

function write([address, size], value) {
  return { address, size, value };
}

function u16(low, high) {
  return (low & 0xff) | ((high & 0xff) << 8);
}

// ---------------------------------------------------------------- flash

function readString(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) {
    end++;
  }
  let text = '';
  for (let i = start; i < end; i++) {
    text += String.fromCharCode(bytes[i]);
  }
  return { text, next: end + 1 };
}

function readTable(view, offset) {
  const table = [];
  for (let i = 0; i < 10; i++) {
    table.push(view.getUint16(offset + i * 2, true));
  }
  return table;
}

export function fpgaVersionFromFlashVersion(version) {
  const text = version.toUpperCase();
  let result = null;
  if (text.startsWith('V2.7.0')) {
    result = 3;
  } else if (text.startsWith('V2.4.623') || text.startsWith('V2.6.0')) {
    result = 2;
  } else if (text.startsWith('V2.') || text.startsWith('V1.')) {
    result = 1;
  } else if (text.startsWith('V') && text.includes('.')) {
    result = parseInt(text.slice(1, text.indexOf('.')), 10);
  }
  return result;
}

// Returns null if the buffer is not a valid flash dump.
export function parseFlash(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = null;
  if (bytes.length >= FLASH_SIZE) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = view.getUint16(0, true);
    const validHeader = header === 0x55aa || header === 0xaa55;
    if (validHeader && view.getUint32(2, true) === 2) {
      result = readFlashFields(bytes, view);
    }
  }
  return result;
}

function readFlashFields(bytes, view) {
  const table = (index) => readTable(view, 6 + index * 20);
  const version = readString(bytes, 207);
  const serial = readString(bytes, version.next);
  const phaseFine = view.getUint16(serial.next + 100, true);
  return {
    calibration: {
      gain: [table(0), table(1)],
      amplitude: [table(2), table(3)],
      compensation: [table(4), table(5)],
    },
    version: version.text,
    serial: serial.text,
    phaseFine,
    fpgaVersion: fpgaVersionFromFlashVersion(version.text),
  };
}

// ---------------------------------------------------------------- settings

export function defaultSettings() {
  const channel = (on) => ({ on, probe: 1, coupling: DC, rangeIndex: 5, offset: 0 });
  return {
    channels: [channel(true), channel(false)],
    rateIndex: 14,
    peak: false,
    trigger: { source: CH1, fall: false, levelDiv: 0, position: 0.5, sweep: SWEEP_AUTO },
  };
}

function pickNumber(value, fallback, low, high) {
  const valid = typeof value === 'number' && Number.isFinite(value);
  return valid ? clip(value, low, high) : fallback;
}

function pickIndex(value, fallback, count) {
  const valid = Number.isInteger(value) && value >= 0 && value < count;
  return valid ? value : fallback;
}

function restoreChannel(saved, base) {
  const source = saved || {};
  return {
    on: typeof source.on === 'boolean' ? source.on : base.on,
    probe: PROBES.includes(source.probe) ? source.probe : base.probe,
    coupling: pickIndex(source.coupling, base.coupling, 3),
    rangeIndex: pickIndex(source.rangeIndex, base.rangeIndex, VOLT_RANGES.length),
    offset: pickNumber(source.offset, base.offset, -0.5, 0.5),
  };
}

// Validates saved settings (from localStorage) against the defaults.
export function restoreSettings(saved) {
  const base = defaultSettings();
  const source = saved || {};
  const trigger = source.trigger || {};
  const restored = {
    channels: [0, 1].map((i) => restoreChannel((source.channels || [])[i], base.channels[i])),
    rateIndex: pickIndex(source.rateIndex, base.rateIndex, SAMPLING_RATES.length),
    peak: typeof source.peak === 'boolean' ? source.peak : base.peak,
    trigger: {
      source: pickIndex(trigger.source, base.trigger.source, 3),
      fall: typeof trigger.fall === 'boolean' ? trigger.fall : base.trigger.fall,
      levelDiv: pickNumber(trigger.levelDiv, base.trigger.levelDiv, -5, 5),
      position: pickNumber(trigger.position, base.trigger.position, 0, 1),
      sweep: pickIndex(trigger.sweep, base.trigger.sweep, SWEEP_ONCE),
    },
  };
  if (!restored.channels.some((channel) => channel.on)) {
    restored.channels[0].on = true;
  }
  return restored;
}

export function channelMask(settings) {
  return settings.channels.reduce((mask, channel, index) => mask | (channel.on ? 1 << index : 0), 0);
}

// ---------------------------------------------------------------- scaling

export function fullScaleVolts(channel) {
  return VOLT_RANGES[channel.rangeIndex] * channel.probe;
}

export function voltsPerDivision(channel) {
  return fullScaleVolts(channel) / DIVISIONS;
}

// Volts = sample * scale + shift. Python: Frame.sy and Frame.ty.
export function sampleScale(channel) {
  const fullScale = fullScaleVolts(channel);
  return { scale: fullScale / ADC_RANGE, shift: -fullScale * channel.offset };
}

export function samplingFor(rateIndex) {
  const rate = SAMPLING_RATES[rateIndex];
  const prescaler = Math.max(1, pyRound(BASE_CLOCK / Math.max(3, rate)));
  const actualRate = BASE_CLOCK / prescaler;
  return { prescaler, rate: actualRate, roll: actualRate < ROLLMODE_THRESHOLD };
}

export function timeRangeSeconds(rateIndex) {
  return SAMPLES / samplingFor(rateIndex).rate;
}

// Roll mode draws the trigger origin on the right (Python: trigger_position = 1).
export function displayedTriggerPosition(settings) {
  return samplingFor(settings.rateIndex).roll ? 1 : settings.trigger.position;
}

// ---------------------------------------------------------------- register commands

export function buildChannelWrites(index, channel, calibration) {
  const range = channel.rangeIndex;
  const compensation = calibration.compensation[index][range];
  const amplitude = calibration.amplitude[index][range];
  const gain = calibration.gain[index][range];
  const groundCounts = ADC_RANGE * channel.offset;
  const zero = clip(pyRound(compensation - (groundCounts * amplitude) / 100), 0, 4095);
  const attenuate = range >= ATTENUATION_THRESHOLD ? 1 : 0;
  const state = (attenuate << 1) | (channel.coupling << 5) | ((channel.on ? 1 : 0) << 7);
  return [
    write(REG.zeroOffset[index], zero),
    write(REG.voltGain[index], clip(gain, 0, 4095)),
    write(REG.channel[index], state),
  ];
}

export function buildSamplingWrites(settings) {
  const sampling = samplingFor(settings.rateIndex);
  return [
    write(REG.timebase, sampling.prescaler),
    write(REG.roll, sampling.roll ? 1 : 0),
    write(REG.deepMemory, ADC_SIZE + (sampling.roll ? 3 : 0)),
    write(REG.peak, settings.peak ? 1 : 0),
  ];
}

// Trigger level in ADC counts, as Python set_trigger computes it.
export function triggerLevelCounts(settings) {
  const channel = settings.channels[settings.trigger.source];
  const counts = pyRound((settings.trigger.levelDiv / DIVISIONS + channel.offset) * ADC_RANGE);
  const fallShift = settings.trigger.fall ? 10 : 0;
  return clip(counts + fallShift, ADC_MIN + 10, ADC_MAX) - fallShift;
}

function buildIdleChannelTrigger(index, channel) {
  const ground = pyRound(ADC_RANGE * channel.offset) & 0xff;
  return [
    write(REG.holdoff[index], HOLDOFF_100NS),
    write(REG.edgeLevel[index], EDGE_LEVEL_DISABLED),
    // Keeps the frequency meter near the zero line when the channel is not the trigger source.
    write(REG.freqRef[index], ground),
  ];
}

function buildSourceTrigger(settings) {
  const { source, fall } = settings.trigger;
  const counts = triggerLevelCounts(settings) + (fall ? 10 : 0);
  return [
    write(REG.edgeLevel[source], u16(counts, counts - 10)),
    write(REG.freqRef[source], (counts - 5) & 0xff),
  ];
}

function triggerRegister(trigger, sweep) {
  const external = trigger.source === EXT ? 1 : 0;
  const channelBit = (trigger.source & 1) << 13;
  const conditionBit = (trigger.fall ? 1 : 0) << 12;
  return external | channelBit | conditionBit | ((sweep & 3) << 10);
}

// Edge mode only. Python set_trigger writes the same registers, in the same order.
// A single capture is armed with the Once sweep bits without touching the selected sweep.
export function buildTriggerWrites(settings, single = false) {
  const { source, position } = settings.trigger;
  const horizontal = pyRound(SAMPLES * clip(0.5 - position, -0.5, 0.5));
  const writes = [
    write(REG.multi, source === EXT ? 2 : 0),
    write(REG.prefixTrigger, (ADC_SIZE >> 1) - horizontal - HTP_ERR),
    write(REG.suffixTrigger, (ADC_SIZE >> 1) + horizontal + HTP_ERR),
  ];
  [CH1, CH2].forEach((index) => {
    if (index !== source) {
      writes.push(...buildIdleChannelTrigger(index, settings.channels[index]));
    }
  });
  if (source === EXT) {
    writes.push(write(REG.holdoff[0], HOLDOFF_100NS));
  } else {
    writes.push(...buildSourceTrigger(settings));
    writes.push(write(REG.holdoff[source], HOLDOFF_100NS));
  }
  writes.push(write(REG.trigger, triggerRegister(settings.trigger, effectiveSweep(settings, single))));
  return writes;
}

export function buildAllWrites(settings, calibration, single = false) {
  return [
    ...buildSamplingWrites(settings),
    ...buildChannelWrites(0, settings.channels[0], calibration),
    ...buildChannelWrites(1, settings.channels[1], calibration),
    ...buildTriggerWrites(settings, single),
  ];
}

export function buildForceTriggerWrites() {
  return [write(REG.forceTrigger, FORCE_TRIGGER_VALUE)];
}

function writeRecord(view, offset, item) {
  view.setUint32(offset, item.address, true);
  view.setUint8(offset + 4, item.size);
  const valueOffset = offset + 5;
  if (item.size === 1) {
    view.setUint8(valueOffset, item.value & 0xff);
  } else if (item.size === 2) {
    view.setUint16(valueOffset, item.value & 0xffff, true);
  } else {
    view.setUint32(valueOffset, item.value >>> 0, true);
  }
  return offset + 5 + item.size;
}

// Splits register writes into messages of at most MAX_MESSAGE_SIZE bytes, order kept.
export function encodeWrites(writes) {
  const messages = [];
  let view = null;
  let used = 0;
  const flush = () => {
    if (view) {
      messages.push(new Uint8Array(view.buffer, 0, used));
    }
    view = null;
  };
  writes.forEach((item) => {
    if (view && used + 5 + item.size > MAX_MESSAGE_SIZE) {
      flush();
    }
    if (!view) {
      view = new DataView(new ArrayBuffer(MAX_MESSAGE_SIZE));
      view.setUint8(0, CMD_WRITE_REGISTERS);
      used = 1;
    }
    used = writeRecord(view, used, item);
  });
  flush();
  return messages;
}

export function encodeMode(mask, mode) {
  return new Uint8Array([CMD_SET_MODE, mask, mode]);
}

export function effectiveSweep(settings, single) {
  return single ? SWEEP_ONCE : settings.trigger.sweep;
}

// Roll mode shows the signal as it comes, so only a single waits for a trigger there.
export function runModeFor(settings, single = false) {
  const modes = [MODE_FREE, MODE_TRIGGERED, MODE_SINGLE];
  const rolling = samplingFor(settings.rateIndex).roll && !single;
  return rolling ? MODE_FREE : modes[effectiveSweep(settings, single)];
}

// ---------------------------------------------------------------- frames

export function createFrameSlot() {
  return { present: false, channel: 0, samples: new Int8Array(SAMPLES), first: 0, timeSum: 0, periodNum: 0 };
}

export function readSequence(message) {
  return (new DataView(message).getUint32(0, true) & ~SINGLE_CAPTURE_FLAG) >>> 0;
}

export function isSingleCapture(message) {
  return (new DataView(message).getUint32(0, true) & SINGLE_CAPTURE_FLAG) !== 0;
}

export function frameCount(messageLength) {
  return Math.floor((messageLength - SEQUENCE_SIZE) / FRAME_SIZE);
}

// Copies one frame of the message into the slot of its channel (slots[0] or slots[1]).
// Python: fetch_iter and _pull_data.
export function parseFrameInto(message, frameIndex, roll, slots) {
  const base = SEQUENCE_SIZE + frameIndex * FRAME_SIZE;
  const view = new DataView(message, base, FRAME_SIZE);
  const slot = slots[view.getUint8(0) & 1];
  const cursor = SAMPLES - clip(view.getUint16(9, true), 0, SAMPLES);
  const skip = roll ? ROLL_SKIP : NON_ROLL_SKIP;
  slot.channel = view.getUint8(0) & 1;
  slot.timeSum = view.getUint32(1, true);
  slot.periodNum = view.getUint32(5, true);
  slot.first = cursor;
  slot.samples.set(new Int8Array(message, base + FRAME_HEADER_SIZE + skip, SAMPLES));
  slot.present = true;
  return slot;
}

// The hardware has no ground relay: the vendor app also forces this in software.
export function forceGround(slot, channel) {
  slot.samples.fill(Math.round(channel.offset * ADC_RANGE));
  slot.timeSum = 0;
  slot.periodNum = 0;
}

export function frequencyHz(timeSum, periodNum) {
  return timeSum ? (periodNum / timeSum) * BASE_CLOCK : 0;
}

const FREQ_MIN_AMPLITUDE = 10;
const FREQ_HYSTERESIS = 0.1;

// Like a bench scope: crossings of the 50 % level, with hysteresis, over whole periods.
// Falling edges count too: a trigger at 50 % can leave a single whole rising period on screen.
export function waveformFrequency(samples, first, low, high, rate) {
  let frequency = 0;
  if (high - low >= FREQ_MIN_AMPLITUDE) {
    const mid = (low + high) / 2;
    const band = (high - low) * FREQ_HYSTERESIS;
    const rising = edgeCrossings(samples, first, mid, band, 1);
    const falling = edgeCrossings(samples, first, mid, band, -1);
    const best = rising.count >= falling.count ? rising : falling;
    const hasWholePeriod = best.count >= 2;
    frequency = hasWholePeriod ? ((best.count - 1) * rate) / (best.last - best.first) : 0;
  }
  return frequency;
}

// Crossings of mid in one direction (1 rising, -1 falling), interpolated between samples.
function edgeCrossings(samples, first, mid, band, direction) {
  const edges = { count: 0, first: 0, last: 0 };
  const level = mid * direction;
  let armed = false;
  for (let i = first + 1; i < SAMPLES; i++) {
    const sample = clip(samples[i], ADC_MIN, ADC_MAX) * direction;
    if (sample < level - band) {
      armed = true;
    } else if (armed && sample >= level) {
      const previous = clip(samples[i - 1], ADC_MIN, ADC_MAX) * direction;
      const crossing = i - (sample - level) / (sample - previous);
      if (edges.count === 0) {
        edges.first = crossing;
      }
      edges.last = crossing;
      edges.count++;
      armed = false;
    }
  }
  return edges;
}

// Python Frame.min/max/avg/rms, computed in volts from clipped samples.
export function measure(slot, channel, rate) {
  const { scale, shift } = sampleScale(channel);
  const count = SAMPLES - slot.first;
  let low = ADC_MAX;
  let high = ADC_MIN;
  let sum = 0;
  let squares = 0;
  const zeroShift = shift / scale;
  for (let i = slot.first; i < SAMPLES; i++) {
    const sample = clip(slot.samples[i], ADC_MIN, ADC_MAX);
    low = Math.min(low, sample);
    high = Math.max(high, sample);
    sum += sample;
    squares += (sample + zeroShift) * (sample + zeroShift);
  }
  const result = { vmin: 0, vmax: 0, vpp: 0, vavg: 0, vrms: 0, frequency: 0 };
  if (count > 0) {
    result.vmin = low * scale + shift;
    result.vmax = high * scale + shift;
    result.vpp = result.vmax - result.vmin;
    result.vavg = (sum / count) * scale + shift;
    result.vrms = Math.sqrt(squares / count) * scale;
    result.frequency = waveformFrequency(slot.samples, slot.first, low, high, rate);
  }
  return result;
}

export function sampleTimeSeconds(index, rate, position) {
  return (index - SAMPLES * position) / rate;
}

// The setup a frame was captured with: frames stay readable after the settings change.
export function captureSetup(settings) {
  return {
    channels: settings.channels.map((channel) => ({ ...channel })),
    rateIndex: settings.rateIndex,
    trigger: { position: settings.trigger.position },
  };
}

// How to draw captured samples with the current settings, like a bench scope does once stopped:
// x fraction = index / SAMPLES * xGain + xShift; y fraction above centre = sample / ADC_RANGE * yGain + yShift.
export function displayMapping(capture, settings, index) {
  const captured = capture.channels[index];
  const current = settings.channels[index];
  const yGain = fullScaleVolts(captured) / fullScaleVolts(current);
  const xGain = samplingFor(settings.rateIndex).rate / samplingFor(capture.rateIndex).rate;
  return {
    yGain,
    yShift: current.offset - captured.offset * yGain,
    xGain,
    xShift: displayedTriggerPosition(settings) - displayedTriggerPosition(capture) * xGain,
  };
}

export function sampleToVolts(sample, channel) {
  const { scale, shift } = sampleScale(channel);
  return sample * scale + shift;
}

// Screen position of a voltage: 0 at the bottom, 1 at the top, ground at 0.5 + offset.
export function voltsToScreen(volts, channel) {
  return volts / fullScaleVolts(channel) + 0.5 + channel.offset;
}

export function screenToVolts(fraction, channel) {
  return (fraction - 0.5 - channel.offset) * fullScaleVolts(channel);
}

// ---------------------------------------------------------------- handle dragging

function snap(value, step) {
  return Number((Math.round(value / step) * step).toFixed(4));
}

// Screen fractions are measured from the top (y) or from the left (x) of the plot.
export function offsetAtScreen(yFraction) {
  return snap(clip(0.5 - yFraction, -OFFSET_LIMIT, OFFSET_LIMIT), FRACTION_STEP);
}

export function levelDivAtScreen(yFraction, offset) {
  return snap(clip((0.5 - offset - yFraction) * DIVISIONS, -LEVEL_LIMIT_DIV, LEVEL_LIMIT_DIV), LEVEL_STEP);
}

export function positionAtScreen(xFraction) {
  return snap(clip(xFraction, 0, 1), FRACTION_STEP);
}

// The trigger stays on the same voltage when the source channel's range changes.
export function levelDivForRange(levelDiv, rangeIndex, newRangeIndex) {
  const level = (levelDiv * VOLT_RANGES[rangeIndex]) / VOLT_RANGES[newRangeIndex];
  return snap(clip(level, -LEVEL_LIMIT_DIV, LEVEL_LIMIT_DIV), LEVEL_STEP);
}

// The "set level to 50 %" key: halfway between the lowest and highest sample of the capture.
export function levelDivAtMidpoint(low, high, captured, current) {
  const level = sampleToVolts((low + high) / 2, captured) / voltsPerDivision(current);
  return snap(clip(level, -LEVEL_LIMIT_DIV, LEVEL_LIMIT_DIV), LEVEL_STEP);
}

// ---------------------------------------------------------------- formatting

const SI_PREFIXES = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n']];

export function formatSi(value, unit) {
  const magnitude = Math.abs(value);
  let text = `0 ${unit}`;
  if (Number.isFinite(value) && magnitude > 0) {
    const entry = SI_PREFIXES.find(([factor]) => magnitude >= factor * 0.9995) || SI_PREFIXES[SI_PREFIXES.length - 1];
    text = `${Number((value / entry[0]).toPrecision(3))} ${entry[1]}${unit}`;
  }
  return text;
}

// ---------------------------------------------------------------- CSV

// columns: [{name, samples, first, scale, shift}]; rows are time-aligned by sample index.
export function buildCsv(columns, rate, position) {
  const lines = [['time_s', ...columns.map((column) => `${column.name}_V`)].join(',')];
  const start = Math.min(...columns.map((column) => column.first));
  for (let i = start; i < SAMPLES; i++) {
    const cells = columns.map((column) => {
      return i >= column.first ? String(column.samples[i] * column.scale + column.shift) : '';
    });
    lines.push([String(sampleTimeSeconds(i, rate, position)), ...cells].join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- FFT

export function createFft(size) {
  const bits = Math.log2(size);
  const reverse = new Uint16Array(size);
  const cosTable = new Float64Array(size / 2);
  const sinTable = new Float64Array(size / 2);
  for (let i = 0; i < size; i++) {
    let value = i;
    let reversed = 0;
    for (let bit = 0; bit < bits; bit++) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    reverse[i] = reversed;
  }
  for (let i = 0; i < size / 2; i++) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / size);
    sinTable[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  return { size, reverse, cosTable, sinTable };
}

function butterflies(plan, real, imag, length) {
  const step = plan.size / length;
  for (let start = 0; start < plan.size; start += length) {
    for (let k = 0; k < length / 2; k++) {
      const cosine = plan.cosTable[k * step];
      const sine = plan.sinTable[k * step];
      const a = start + k;
      const b = a + length / 2;
      const re = real[b] * cosine - imag[b] * sine;
      const im = real[b] * sine + imag[b] * cosine;
      real[b] = real[a] - re;
      imag[b] = imag[a] - im;
      real[a] += re;
      imag[a] += im;
    }
  }
}

// In-place forward FFT. The input must already be in bit-reversed order (see loadWindowed).
export function transform(plan, real, imag) {
  for (let length = 2; length <= plan.size; length *= 2) {
    butterflies(plan, real, imag, length);
  }
}

export function hannWindow(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

export function fftSizeFor(sampleCount) {
  return 2 ** Math.floor(Math.log2(Math.min(sampleCount, MAX_FFT_SIZE)));
}

// Windowed spectrum of the centred part of the valid samples, in dBV, like Python _rfft.
// plan.size must equal fftSizeFor(valid count); fills db[0 .. size/2].
export function computeSpectrum(plan, window, slot, channel, work, db) {
  const { scale, shift } = sampleScale(channel);
  const size = plan.size;
  const trim = ((SAMPLES - slot.first - size) >> 1) + slot.first;
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    windowSum += window[i];
    work.real[plan.reverse[i]] = (slot.samples[trim + i] * scale + shift) * window[i];
    work.imag[plan.reverse[i]] = 0;
  }
  transform(plan, work.real, work.imag);
  const amplitudeScale = 2 / size / (windowSum / size);
  for (let bin = 0; bin <= size / 2; bin++) {
    const magnitude = Math.hypot(work.real[bin], work.imag[bin]) * amplitudeScale;
    db[bin] = 20 * Math.log10(Math.max(magnitude, 1e-9));
  }
  return size;
}

// ---------------------------------------------------------------- autoset

// Largest rate index not above the rate that shows about three periods (Python autoset).
export function rateIndexForPeriod(periodSeconds) {
  const wanted = SAMPLES / (periodSeconds * 3);
  let index = 0;
  SAMPLING_RATES.forEach((rate, i) => {
    if (rate <= wanted) {
      index = i;
    }
  });
  return index;
}

function firstRangeAtLeast(volts) {
  const index = VOLT_RANGES.findIndex((range) => range >= volts - 1e-12);
  return index < 0 ? VOLT_RANGES.length - 1 : index;
}

// One autoset iteration for a channel (Python autoset body). Returns
// {off: true} for a flat channel, else {rangeIndex, level} with level in ADC counts.
export function autosetChannel(rangeIndex, offset, sampleMin, sampleMax) {
  const groundCounts = pyRound(ADC_RANGE * offset);
  const low = Math.min(groundCounts, sampleMin);
  const high = Math.max(groundCounts, sampleMax);
  const amplitude = Math.max(Math.abs(low), Math.abs(high)) * 2;
  let result = { off: true };
  if (high >= ADC_MAX || low <= ADC_MIN) {
    result = { rangeIndex: (rangeIndex + VOLT_RANGES.length) >> 1, level: null, amplitude };
  } else if (amplitude >= 16) {
    const wanted = (amplitude * 1.1 * VOLT_RANGES[rangeIndex]) / ADC_RANGE;
    const next = firstRangeAtLeast(wanted);
    const level = clip(pyRound(((high + low) / 2) * (VOLT_RANGES[rangeIndex] / VOLT_RANGES[next])), -100, 100);
    result = { rangeIndex: next, level, amplitude };
  }
  return result;
}

export function frameMinMax(slot) {
  let low = ADC_MAX;
  let high = ADC_MIN;
  for (let i = slot.first; i < SAMPLES; i++) {
    low = Math.min(low, slot.samples[i]);
    high = Math.max(high, slot.samples[i]);
  }
  return { low, high };
}
