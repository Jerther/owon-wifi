import { displayedTriggerPosition, formatSi, fullScaleVolts, samplingFor, timeRangeSeconds } from '../../scope_logic.js';
import { GridPainter } from './grid_painter.js';

// Values of the major grid lines, drawn with them under the traces: vertical scales at the right above each line,
// one per shown channel side by side, and the horizontal scale along the bottom.
// A channel's labels take its hue at the lightness of the grid line they belong to.
export class AxisPainter {
  static FONT_PX = 10;
  static MARGIN_PX = 3;
  static GAP_PX = 8;
  // Clears the trigger level tag on the right edge.
  static RIGHT_MARGIN_PX = 14;
  static DIVISIONS = 10;

  // channelColors: '#rrggbb' per channel.
  constructor(painter, channelColors) {
    this.painter = painter;
    this.channelHues = channelColors.map(AxisPainter.hueOf);
  }

  // { hue, saturation } of a '#rrggbb' colour.
  static hueOf(hex) {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const lightness = (max + min) / 2;
    let hue = 0;
    if (delta > 0 && max === r) {
      hue = ((g - b) / delta + 6) % 6;
    } else if (delta > 0 && max === g) {
      hue = (b - r) / delta + 2;
    } else if (delta > 0) {
      hue = (r - g) / delta + 4;
    }
    const saturation = delta > 0 ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    return { hue: hue * 60, saturation: saturation * 100 };
  }

  // An exact zero avoids labels such as "1e-17 V".
  static label(value, unit, step) {
    const snapped = Math.abs(value) < step * 1e-6 ? 0 : value;
    return unit === 'dB' ? `${snapped} dB` : formatSi(snapped, unit);
  }

  static volts(fullScale, origin, sign, channel) {
    const step = fullScale / AxisPainter.DIVISIONS;
    return { value: (i) => sign * (origin - i / AxisPainter.DIVISIONS) * fullScale, unit: 'V', step, channel };
  }

  // { vertical: [scale, ...], horizontal: scale }; a scale gives line i's value (0 at the top or left), its unit,
  // its spacing and its channel, or null for the grid colour.
  scales() {
    const { settings, ui } = this.painter.store;
    const channels = settings.channels;
    const divisions = AxisPainter.DIVISIONS;
    let scales = null;
    if (ui.view === 'fft') {
      const top = this.painter.spectrum.top;
      const nyquist = samplingFor(settings.rateIndex).rate / 2;
      scales = {
        vertical: [{ value: (i) => top - i * 10, unit: 'dB', step: 10, channel: null }],
        horizontal: { value: (i) => (i / divisions) * nyquist, unit: 'Hz', step: nyquist / divisions, channel: null },
      };
    } else if (ui.view === 'xy') {
      scales = {
        vertical: [AxisPainter.volts(fullScaleVolts(channels[1]), 0.5, 1, 1)],
        horizontal: AxisPainter.volts(fullScaleVolts(channels[0]), 0.5, -1, 0),
      };
    } else {
      const range = timeRangeSeconds(settings.rateIndex);
      const origin = displayedTriggerPosition(settings);
      const shown = [0, 1].filter((index) => channels[index].on);
      scales = {
        vertical: shown.map((index) => AxisPainter.volts(fullScaleVolts(channels[index]), 0.5 - channels[index].offset, 1, index)),
        horizontal: { value: (i) => (i / divisions - origin) * range, unit: 's', step: range / divisions, channel: null },
      };
    }
    return scales;
  }

  color(i, channel) {
    const line = i === AxisPainter.DIVISIONS / 2 ? GridPainter.CENTRE : GridPainter.LINE;
    const base = channel === null ? line : { ...this.channelHues[channel], lightness: line.lightness };
    return GridPainter.color(base, this.painter.store.display.gridBrightness);
  }

  draw(width, height) {
    const context = this.painter.context;
    const ratio = this.painter.ratio;
    const { vertical, horizontal } = this.scales();
    context.font = `${Math.round(AxisPainter.FONT_PX * ratio)}px system-ui, sans-serif`;
    context.textBaseline = 'bottom';
    this.drawVertical(vertical, width, height, ratio);
    this.drawHorizontal(horizontal, width, height, ratio);
  }

  // The top and bottom lines have no room above them for a label; the last scale sits at the right edge.
  drawVertical(scales, width, height, ratio) {
    const context = this.painter.context;
    context.textAlign = 'right';
    for (let i = 1; i < AxisPainter.DIVISIONS; i++) {
      const y = Math.round((i * height) / AxisPainter.DIVISIONS) - AxisPainter.MARGIN_PX * ratio;
      let x = width - AxisPainter.RIGHT_MARGIN_PX * ratio;
      for (let index = scales.length - 1; index >= 0; index--) {
        const scale = scales[index];
        const text = AxisPainter.label(scale.value(i), scale.unit, scale.step);
        context.fillStyle = this.color(i, scale.channel);
        context.fillText(text, x, y);
        x -= context.measureText(text).width + AxisPainter.GAP_PX * ratio;
      }
    }
  }

  // The right edge line has no room on its right for a label.
  drawHorizontal(scale, width, height, ratio) {
    const context = this.painter.context;
    const y = height - AxisPainter.MARGIN_PX * ratio;
    context.textAlign = 'left';
    for (let i = 0; i < AxisPainter.DIVISIONS; i++) {
      const x = Math.round((i * width) / AxisPainter.DIVISIONS) + AxisPainter.MARGIN_PX * ratio;
      context.fillStyle = this.color(i, scale.channel);
      context.fillText(AxisPainter.label(scale.value(i), scale.unit, scale.step), x, y);
    }
  }
}
