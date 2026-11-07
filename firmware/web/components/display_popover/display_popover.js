import { Component, useExternalListener, useRef, useState } from '../../core/owl.js';
import { GRID_BRIGHTNESS_RANGE, TRACE_WIDTH_RANGE } from '../../core/store.js';
import { SliderField } from '../controls/slider_field/slider_field.js';

// Icon button opening a small panel with the screen's grid brightness and trace width.
export class DisplayPopover extends Component {
  static template = 'owon.DisplayPopover';
  static components = { SliderField };
  static DEFAULTS = { gridBrightness: 1, traceWidth: 1.5 };

  setup() {
    this.store = useState(this.env.store);
    this.state = useState({ open: false });
    this.rootRef = useRef('root');
    this.toggleRef = useRef('toggle');
    this.gridRange = GRID_BRIGHTNESS_RANGE;
    this.traceRange = TRACE_WIDTH_RANGE;
    useExternalListener(window, 'pointerdown', this.onWindowPointerDown);
    useExternalListener(window, 'keydown', this.onWindowKeyDown);
  }

  get gridText() {
    return `${Math.round(this.store.display.gridBrightness * 100)} %`;
  }

  get traceText() {
    return `${this.store.display.traceWidth} px`;
  }

  toggle() {
    this.state.open = !this.state.open;
  }

  reset() {
    Object.entries(DisplayPopover.DEFAULTS).forEach(([key, value]) => this.env.session.set(`display.${key}`, value));
  }

  onWindowPointerDown(event) {
    const isOutside = !this.rootRef.el.contains(event.target);
    if (this.state.open && isOutside) {
      this.state.open = false;
    }
  }

  onWindowKeyDown(event) {
    if (this.state.open && event.key === 'Escape') {
      this.state.open = false;
      this.toggleRef.el.focus();
    }
  }
}
