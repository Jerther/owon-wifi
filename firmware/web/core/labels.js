import { SAMPLING_RATES, VOLT_RANGES, formatSi, samplingFor, timeRangeSeconds } from '../scope_logic.js';

export const COUPLING_NAMES = ['AC', 'DC', 'GND soft'];

export function rangeLabel(rangeIndex, probe) {
  return `${formatSi((VOLT_RANGES[rangeIndex] * probe) / 10, 'V')}/div`;
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
