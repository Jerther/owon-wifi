import {
  ADC_RANGE, EXT, SAMPLES, clip, displayMapping, displayedTriggerPosition, interpolatedSample, samplingFor,
} from '../../scope_logic.js';
import { cursorAxes } from '../../core/store.js';
import { SpectrumPainter } from './spectrum_painter.js';

// The ten-division grid; its brightness scales the lightness of the default colours.
export class GridPainter {
  static LINE = { hue: 215, saturation: 16, lightness: 15 };
  static CENTRE = { hue: 216, saturation: 15, lightness: 27 };
  static LIGHTNESS_RANGE = { min: 2, max: 75 };

  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.ratio = 1;
  }

  static color(base, brightness) {
    const { min, max } = GridPainter.LIGHTNESS_RANGE;
    const lightness = clip(base.lightness * brightness, min, max);
    return `hsl(${base.hue} ${base.saturation}% ${lightness.toFixed(1)}%)`;
  }

  draw(brightness) {
    const { width, height } = this.canvas;
    const context = this.context;
    const lineColor = GridPainter.color(GridPainter.LINE, brightness);
    const centreColor = GridPainter.color(GridPainter.CENTRE, brightness);
    context.clearRect(0, 0, width, height);
    context.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = Math.round((i * width) / 10) + 0.5;
      const y = Math.round((i * height) / 10) + 0.5;
      context.strokeStyle = i === 5 ? centreColor : lineColor;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    this.drawTicks(centreColor);
  }

  drawTicks(color) {
    const { width, height } = this.canvas;
    const context = this.context;
    const half = 3 * this.ratio;
    context.strokeStyle = color;
    context.beginPath();
    for (let i = 0; i < 50; i++) {
      const x = (i * width) / 50;
      const y = (i * height) / 50;
      context.moveTo(x, height / 2 - half);
      context.lineTo(x, height / 2 + half);
      context.moveTo(width / 2 - half, y);
      context.lineTo(width / 2 + half, y);
    }
    context.stroke();
  }
}

// Traces, markers and cursors of the time view, the XY view, and the FFT view through SpectrumPainter.
export class TracePainter {
  static COLORS = ['#ffd400', '#00d4ff'];
  static MARKER_WIDTH = 1.5;
  static POSITION_LINE_COLOR = '#6b7480';
  static V_CURSOR_COLOR = '#ff7ad9';
  static T_CURSOR_COLOR = '#9be26a';
  static MAX_SAMPLES_PER_PIXEL_INTERPOLATED = 0.5;

  constructor(canvas, store, session) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.store = store;
    this.session = session;
    this.ratio = 1;
    this.spectrum = new SpectrumPainter(this);
  }

  // guide: channel whose offset is being dragged, or null.
  draw(guide) {
    const { width, height } = this.canvas;
    const view = this.store.ui.view;
    this.context.clearRect(0, 0, width, height);
    if (view === 'time') {
      this.drawTimeView(width, height, guide);
    } else if (view === 'fft') {
      this.spectrum.draw(width, height);
    } else {
      this.drawXyView(width, height);
    }
  }

  // ------------------------------------------------------------ strokes

  stroke(color, cssWidth) {
    const context = this.context;
    context.strokeStyle = color;
    context.lineWidth = cssWidth * this.ratio;
    context.lineJoin = 'round';
    context.stroke();
  }

  strokeTrace(index) {
    this.stroke(TracePainter.COLORS[index], this.store.display.traceWidth);
  }

  strokeDashedLine(x1, y1, x2, y2, color) {
    const context = this.context;
    context.setLineDash([4 * this.ratio, 6 * this.ratio]);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    this.stroke(color, TracePainter.MARKER_WIDTH);
    context.setLineDash([]);
  }

  // ------------------------------------------------------------ time view

  drawTimeView(width, height, guide) {
    const channels = this.store.settings.channels;
    this.session.slots.forEach((slot, index) => {
      if (slot.present && channels[index].on) {
        this.drawTrace(slot, index, width, height);
      }
    });
    this.drawGroundMarkers(height);
    this.drawTriggerMarkers(width, height);
    this.drawChannelGuide(width, height, guide);
    this.drawCursors(width, height);
  }

  drawTrace(slot, index, width, height) {
    const mapping = displayMapping(this.session.capture, this.store.settings, index);
    const y = (sample) => height * (0.5 - (sample / ADC_RANGE) * mapping.yGain - mapping.yShift);
    const samplesPerPixel = SAMPLES / (width * mapping.xGain);
    this.context.beginPath();
    if (this.isSparseFullRate(samplesPerPixel)) {
      this.traceInterpolated(slot, mapping, y, width);
    } else if (samplesPerPixel < 2) {
      this.tracePolyline(slot, mapping, y, width);
    } else {
      this.traceColumns(slot, mapping, y, width);
    }
    this.strokeTrace(index);
  }

  // sin(x)/x only rebuilds the signal at 100 MS/s, where the 25 MHz input bandwidth keeps it under Nyquist.
  isSparseFullRate(samplesPerPixel) {
    const fullRate = samplingFor(this.session.capture.rateIndex).prescaler === 1;
    return samplesPerPixel < TracePainter.MAX_SAMPLES_PER_PIXEL_INTERPOLATED && fullRate;
  }

  // Sample index at the left edge of the plot, which is not 0 once the capture is zoomed or moved.
  static leftEdgeSample(mapping) {
    return (-mapping.xShift / mapping.xGain) * SAMPLES;
  }

  pathPoint(x, y, isFirst) {
    if (isFirst) {
      this.context.moveTo(x, y);
    } else {
      this.context.lineTo(x, y);
    }
  }

  tracePolyline(slot, mapping, y, width) {
    const step = (width * mapping.xGain) / SAMPLES;
    const left = TracePainter.leftEdgeSample(mapping);
    const start = Math.max(slot.first, Math.floor(left) - 1);
    const end = Math.min(SAMPLES, Math.ceil(left + width / step) + 1);
    for (let i = start; i < end; i++) {
      this.pathPoint((i + 0.5 - left) * step, y(slot.samples[i]), i === start);
    }
  }

  traceColumns(slot, mapping, y, width) {
    const perColumn = SAMPLES / (width * mapping.xGain);
    const left = TracePainter.leftEdgeSample(mapping);
    let isFirst = true;
    for (let column = 0; column < width; column++) {
      const start = Math.max(slot.first, Math.floor(left + column * perColumn));
      const end = Math.min(SAMPLES, Math.floor(left + (column + 1) * perColumn));
      if (end > start) {
        this.addColumn(slot.samples, start, end, column + 0.5, y, isFirst);
        isFirst = false;
      }
    }
  }

  addColumn(samples, start, end, x, y, isFirst) {
    let low = samples[start];
    let high = low;
    for (let i = start + 1; i < end; i++) {
      low = Math.min(low, samples[i]);
      high = Math.max(high, samples[i]);
    }
    this.pathPoint(x, y(samples[start]), isFirst);
    this.context.lineTo(x, y(low));
    this.context.lineTo(x, y(high));
    this.context.lineTo(x, y(samples[end - 1]));
  }

  traceInterpolated(slot, mapping, y, width) {
    const step = (width * mapping.xGain) / SAMPLES;
    const left = TracePainter.leftEdgeSample(mapping);
    const firstX = Math.max(0, Math.ceil((slot.first + 0.5 - left) * step));
    const lastX = Math.min(width, Math.floor((SAMPLES - 0.5 - left) * step));
    for (let x = firstX; x <= lastX; x++) {
      const value = y(interpolatedSample(slot.samples, slot.first, left + x / step - 0.5));
      this.pathPoint(x, value, x === firstX);
    }
  }

  // ------------------------------------------------------------ markers

  drawTag(x, y, direction, color, label) {
    const context = this.context;
    const size = 7 * this.ratio;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + direction * size * 1.6, y - size);
    context.lineTo(x + direction * size * 1.6, y + size);
    context.closePath();
    context.fill();
    context.fillStyle = '#000';
    context.font = `${Math.round(9 * this.ratio)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + direction * size * 1.1, y);
  }

  drawPositionMarker(x) {
    const context = this.context;
    const size = 7 * this.ratio;
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(x, size * 1.6);
    context.lineTo(x - size, 0);
    context.lineTo(x + size, 0);
    context.closePath();
    context.fill();
  }

  drawGroundMarkers(height) {
    this.store.settings.channels.forEach((channel, index) => {
      if (channel.on) {
        this.drawTag(0, height * (0.5 - channel.offset), 1, TracePainter.COLORS[index], String(index + 1));
      }
    });
  }

  drawTriggerMarkers(width, height) {
    const settings = this.store.settings;
    const { source, levelDiv } = settings.trigger;
    const x = displayedTriggerPosition(settings) * width;
    this.strokeDashedLine(x, 0, x, height, TracePainter.POSITION_LINE_COLOR);
    this.drawPositionMarker(x);
    if (source !== EXT) {
      const color = TracePainter.COLORS[source];
      const y = height * (0.5 - settings.channels[source].offset - levelDiv / 10);
      this.strokeDashedLine(0, y, width, y, `${color}99`);
      this.drawTag(width, clip(y, 0, height), -1, color, 'T');
    }
  }

  drawChannelGuide(width, height, guide) {
    if (guide !== null) {
      const y = height * (0.5 - this.store.settings.channels[guide].offset);
      this.strokeDashedLine(0, y, width, y, TracePainter.COLORS[guide]);
    }
  }

  drawCursors(width, height) {
    const ui = this.store.ui;
    const axes = cursorAxes(ui);
    if (axes.vertical) {
      ui.vCursors.forEach((fraction) => {
        const y = height * (1 - fraction);
        this.strokeDashedLine(0, y, width, y, TracePainter.V_CURSOR_COLOR);
      });
    }
    if (axes.horizontal) {
      ui.tCursors.forEach((fraction) => {
        this.strokeDashedLine(width * fraction, 0, width * fraction, height, TracePainter.T_CURSOR_COLOR);
      });
    }
  }

  // ------------------------------------------------------------ XY view

  // Fraction of the plot from its centre, ground centred, at the current range.
  xyFraction(sample, index) {
    const capture = this.session.capture;
    const mapping = displayMapping(capture, this.store.settings, index);
    return (sample / ADC_RANGE - capture.channels[index].offset) * mapping.yGain;
  }

  drawXyView(width, height) {
    const [slotX, slotY] = this.session.slots;
    if (slotX.present && slotY.present) {
      const first = Math.max(slotX.first, slotY.first);
      this.context.beginPath();
      for (let i = first; i < SAMPLES; i++) {
        const x = width * (0.5 + this.xyFraction(slotX.samples[i], 0));
        const y = height * (0.5 - this.xyFraction(slotY.samples[i], 1));
        this.pathPoint(x, y, i === first);
      }
      this.strokeTrace(0);
    }
  }
}
