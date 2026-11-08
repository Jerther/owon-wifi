import {
  SAMPLES, displayedTriggerPosition, formatSi, sampleTimeSeconds, samplingFor, screenToVolts,
} from '../scope_logic.js';
import { cursorAxes } from './store.js';

function voltageCursorText({ settings, ui }) {
  const [a, b] = ui.vCursors.map((fraction) => screenToVolts(fraction, settings.channels[ui.cursorChannel]));
  return `CH${ui.cursorChannel + 1} ${formatSi(a, 'V')} / ${formatSi(b, 'V')}  dV ${formatSi(b - a, 'V')}`;
}

function timeCursorText({ settings, ui }) {
  const sampling = samplingFor(settings.rateIndex);
  const position = displayedTriggerPosition(settings);
  const [a, b] = ui.tCursors.map((fraction) => sampleTimeSeconds(fraction * SAMPLES, sampling.displayRate, position));
  const delta = Math.abs(b - a);
  return `dT ${formatSi(delta, 's')}${delta > 0 ? ` (${formatSi(1 / delta, 'Hz')})` : ''}`;
}

function cursorText(store) {
  const axes = cursorAxes(store.ui);
  const parts = [];
  if (axes.vertical) {
    parts.push(voltageCursorText(store));
  }
  if (axes.horizontal) {
    parts.push(timeCursorText(store));
  }
  return parts.join('  |  ');
}

function fftText(store, fft) {
  let text = '';
  if (fft) {
    const parts = [`0 - ${formatSi(fft.rate / 2, 'Hz')}, ${formatSi(fft.rate / 20, 'Hz')}/div, ${fft.top} dBV top, 10 dB/div`];
    fft.peaks.forEach((peak, index) => {
      if (peak && store.settings.channels[index].on) {
        parts.push(`CH${index + 1} peak ${formatSi(peak.frequency, 'Hz')} ${peak.db.toFixed(1)} dBV`);
      }
    });
    text = parts.join('  |  ');
  }
  return text;
}

// The line under the screen: cursor readings, the FFT scale and peaks, or the XY axes.
export function infoText(store, status) {
  let text = cursorText(store);
  if (store.ui.view === 'fft') {
    text = fftText(store, status.fft);
  } else if (store.ui.view === 'xy') {
    text = 'X: CH1, Y: CH2';
  }
  return text;
}
