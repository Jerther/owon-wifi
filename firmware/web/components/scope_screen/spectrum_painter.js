import { MAX_FFT_SIZE, SAMPLES, clip, computeSpectrum, createFft, fftSizeFor, hannWindow, samplingFor } from '../../scope_logic.js';

// FFT view: spectra of both channels in dBV, top of the scale rounded above the highest peak.
export class SpectrumPainter {
  static SPAN_DB = 100;
  static MIN_SIZE = 16;

  constructor(painter) {
    this.painter = painter;
    this.work = { real: new Float64Array(MAX_FFT_SIZE), imag: new Float64Array(MAX_FFT_SIZE) };
    this.plans = new Map();
    this.windows = new Map();
    this.db = [new Float32Array(MAX_FFT_SIZE / 2 + 1), new Float32Array(MAX_FFT_SIZE / 2 + 1)];
    this.sizes = [0, 0];
    this.top = 20;
  }

  static cached(map, size, make) {
    if (!map.has(size)) {
      map.set(size, make(size));
    }
    return map.get(size);
  }

  isShown(index) {
    return this.sizes[index] > 0 && this.painter.store.settings.channels[index].on;
  }

  update(index) {
    const session = this.painter.session;
    const slot = session.slots[index];
    const size = slot.present ? fftSizeFor(SAMPLES - slot.first) : 0;
    this.sizes[index] = 0;
    if (size >= SpectrumPainter.MIN_SIZE) {
      const plan = SpectrumPainter.cached(this.plans, size, createFft);
      const window = SpectrumPainter.cached(this.windows, size, hannWindow);
      this.sizes[index] = computeSpectrum(plan, window, slot, session.capture.channels[index], this.work, this.db[index]);
    }
  }

  peakBin(index) {
    const db = this.db[index];
    let peak = 2;
    for (let bin = 3; bin <= this.sizes[index] / 2; bin++) {
      peak = db[bin] > db[peak] ? bin : peak;
    }
    return peak;
  }

  draw(width, height) {
    let maxDb = -SpectrumPainter.SPAN_DB;
    [0, 1].forEach((index) => {
      this.update(index);
      if (this.isShown(index)) {
        maxDb = Math.max(maxDb, this.db[index][this.peakBin(index)]);
      }
    });
    this.top = Math.ceil((maxDb + 5) / 10) * 10;
    [0, 1].forEach((index) => {
      if (this.isShown(index)) {
        this.drawSpectrum(index, width, height);
      }
    });
  }

  drawSpectrum(index, width, height) {
    const db = this.db[index];
    const bins = this.sizes[index] / 2;
    const context = this.painter.context;
    context.beginPath();
    for (let bin = 0; bin <= bins; bin++) {
      const y = clip(((this.top - db[bin]) / SpectrumPainter.SPAN_DB) * height, 0, height);
      this.painter.pathPoint((bin / bins) * width, y, bin === 0);
    }
    this.painter.strokeTrace(index);
  }

  // { top, rate, peaks: [{ frequency, db } | null, ...] } for the FFT readout.
  summary() {
    const { session, store } = this.painter;
    const rate = samplingFor((session.capture || store.settings).rateIndex).rate;
    const peaks = [0, 1].map((index) => (this.isShown(index) ? this.peak(index, rate) : null));
    return { top: this.top, rate, peaks };
  }

  peak(index, rate) {
    const bin = this.peakBin(index);
    return { frequency: (bin * rate) / this.sizes[index], db: this.db[index][bin] };
  }
}
