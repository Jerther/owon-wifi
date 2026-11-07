import { Component, useState } from '../../core/owl.js';
import { cursorAxes } from '../../core/store.js';
import {
  SAMPLES, displayedTriggerPosition, formatSi, sampleTimeSeconds, samplingFor, screenToVolts,
} from '../../scope_logic.js';

export class InfoLine extends Component {
  static template = 'owon.InfoLine';

  setup() {
    this.store = useState(this.env.store);
    this.status = useState(this.env.session.status);
  }

  get text() {
    let text = this.cursorText;
    if (this.store.ui.view === 'fft') {
      text = this.fftText;
    } else if (this.store.ui.view === 'xy') {
      text = 'X: CH1, Y: CH2';
    }
    return text;
  }

  get voltageCursorText() {
    const { settings, ui } = this.store;
    const [a, b] = ui.vCursors.map((fraction) => screenToVolts(fraction, settings.channels[ui.cursorChannel]));
    return `CH${ui.cursorChannel + 1} ${formatSi(a, 'V')} / ${formatSi(b, 'V')}  dV ${formatSi(b - a, 'V')}`;
  }

  get timeCursorText() {
    const { settings, ui } = this.store;
    const sampling = samplingFor(settings.rateIndex);
    const position = displayedTriggerPosition(settings);
    const [a, b] = ui.tCursors.map((fraction) => sampleTimeSeconds(fraction * SAMPLES, sampling.displayRate, position));
    const delta = Math.abs(b - a);
    return `dT ${formatSi(delta, 's')}${delta > 0 ? ` (${formatSi(1 / delta, 'Hz')})` : ''}`;
  }

  get cursorText() {
    const axes = cursorAxes(this.store.ui);
    const parts = [];
    if (axes.vertical) {
      parts.push(this.voltageCursorText);
    }
    if (axes.horizontal) {
      parts.push(this.timeCursorText);
    }
    return parts.join('  |  ');
  }

  get fftText() {
    const fft = this.status.fft;
    let text = '';
    if (fft) {
      const parts = [`0 - ${formatSi(fft.rate / 2, 'Hz')}, ${formatSi(fft.rate / 20, 'Hz')}/div, ${fft.top} dBV top, 10 dB/div`];
      fft.peaks.forEach((peak, index) => {
        if (peak && this.store.settings.channels[index].on) {
          parts.push(`CH${index + 1} peak ${formatSi(peak.frequency, 'Hz')} ${peak.db.toFixed(1)} dBV`);
        }
      });
      text = parts.join('  |  ');
    }
    return text;
  }
}
