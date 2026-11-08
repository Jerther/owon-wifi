import { MEASURES, channelLabel, measureText, timeLabel } from '../../core/labels.js';
import { infoText } from '../../core/info_text.js';
import { TracePainter } from './screen_painters.js';

const BACKGROUND = '#000000';
const TEXT = '#e6e7ea';
const MUTED = '#8b8f97';
const RULE = '#2a2c30';
const FONT_PX = 13;
const GAP_PX = 14;

// The caption under the screen: scales, measurements, info line and date, as lines of coloured segments.
export function snapshotLines(store, status) {
  const channels = store.settings.channels;
  const shown = [0, 1].filter((index) => channels[index].on);
  const scales = shown.map((index) => ({ text: channelLabel(index, channels[index]), color: TracePainter.COLORS[index] }));
  scales.push({ text: timeLabel(store.settings.rateIndex), color: TEXT });
  const measures = shown.map((index) => MEASURES.map((measure) => ({
    text: `${measure.label} ${measureText(status.measures[index], measure, channels[index])}`,
    color: TracePainter.COLORS[index],
  })));
  const info = infoText(store, status);
  const lines = [scales, ...measures];
  if (info) {
    lines.push([{ text: info, color: TEXT }]);
  }
  lines.push([{ text: new Date().toLocaleString(), color: MUTED }]);
  return lines;
}

// Places each segment, wrapping to a new row when it would pass the right edge.
function layout(context, lines, width, pad, gap) {
  const placed = [];
  let row = 0;
  lines.forEach((segments) => {
    let x = pad;
    segments.forEach((segment) => {
      const segmentWidth = context.measureText(segment.text).width;
      const wraps = x > pad && x + segmentWidth > width - pad;
      if (wraps) {
        row += 1;
        x = pad;
      }
      placed.push({ ...segment, x, row });
      x += segmentWidth + gap;
    });
    row += 1;
  });
  return { placed, rows: row };
}

// One image of the screen layers with the caption below, at the canvases' pixel ratio.
export function composeSnapshot(layers, lines, ratio) {
  const { width, height } = layers[0];
  const pad = Math.round(10 * ratio);
  const lineHeight = Math.round(FONT_PX * 1.6 * ratio);
  const font = `${Math.round(FONT_PX * ratio)}px system-ui, sans-serif`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = font;
  const { placed, rows } = layout(context, lines, width, pad, Math.round(GAP_PX * ratio));
  canvas.width = width;
  canvas.height = height + rows * lineHeight + pad * 2;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  layers.forEach((layer) => context.drawImage(layer, 0, 0));
  context.fillStyle = RULE;
  context.fillRect(0, height, width, Math.max(1, Math.round(ratio)));
  context.font = font;
  context.textBaseline = 'middle';
  placed.forEach((segment) => {
    context.fillStyle = segment.color;
    context.fillText(segment.text, segment.x, height + pad + (segment.row + 0.5) * lineHeight);
  });
  return canvas;
}
