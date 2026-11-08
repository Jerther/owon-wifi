import {
  SAMPLING_RATES, VOLT_RANGES, formatSi, formatSiPrecise, formatVoltsForChannel, samplingFor, timeRangeSeconds,
} from '../scope_logic.js';

export const COUPLING_NAMES = ['AC', 'DC', 'GND soft'];
export const MEASURES = [
  { label: 'Frequency', key: 'frequency', unit: 'Hz' },
  { label: 'Vpp', key: 'vpp', unit: 'V' },
  { label: 'Vmax', key: 'vmax', unit: 'V' },
  { label: 'Vmin', key: 'vmin', unit: 'V' },
  { label: 'Vavg', key: 'vavg', unit: 'V' },
  { label: 'Vrms', key: 'vrms', unit: 'V' },
];

export function rangeLabel(rangeIndex, probe) {
  return `${formatSi((VOLT_RANGES[rangeIndex] * probe) / 10, 'V')}/div`;
}

export function channelLabel(index, channel) {
  return `CH${index + 1} ${rangeLabel(channel.rangeIndex, channel.probe)} ${COUPLING_NAMES[channel.coupling]}`;
}

// result: one channel's measurements, or null before the first frame.
export function measureText(result, measure, channel) {
  const value = result ? result[measure.key] : null;
  const known = value !== null && !(measure.key === 'frequency' && value <= 0);
  let text = '-';
  if (known && measure.unit === 'V') {
    text = formatVoltsForChannel(value, channel);
  } else if (known) {
    text = formatSiPrecise(value, measure.unit);
  }
  return text;
}

export function timeLabel(rateIndex) {
  return `${formatSi(timeRangeSeconds(rateIndex) / 10, 's')}/div`;
}

export function rangeOptions(probe) {
  return VOLT_RANGES.map((_, index) => ({ value: index, label: rangeLabel(index, probe) }));
}

// Longest time per division first, as on the scope's knob.
export function timeOptions() {
  const options = [];
  for (let index = SAMPLING_RATES.length - 1; index >= 0; index--) {
    const roll = samplingFor(index).roll ? ' (roll)' : '';
    options.push({ value: index, label: `${timeLabel(index)}${roll}` });
  }
  return options;
}
