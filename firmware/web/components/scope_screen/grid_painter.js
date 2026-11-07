import { clip } from '../../scope_logic.js';

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
