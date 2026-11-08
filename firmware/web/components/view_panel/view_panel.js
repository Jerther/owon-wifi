import { Component, useState } from '../../core/owl.js';
import { SegmentedChoice } from '../controls/segmented_choice/segmented_choice.js';
import { ToggleButton } from '../controls/toggle_button/toggle_button.js';

export class ViewPanel extends Component {
  static template = 'owon.ViewPanel';
  static components = { SegmentedChoice, ToggleButton };
  static VIEWS = [{ value: 'time', label: 'Time' }, { value: 'fft', label: 'FFT' }, { value: 'xy', label: 'XY' }];
  static CURSOR_CHANNELS = [{ value: 0, label: 'Cursor CH1' }, { value: 1, label: 'Cursor CH2' }];

  setup() {
    this.store = useState(this.env.store);
  }

  get cursorChannelDisabled() {
    return !this.store.ui.cursorsV;
  }

  exportCsv() {
    this.env.session.exportCsv();
  }

  restoreDefaults() {
    if (window.confirm('Reset the scope settings to their defaults? Every connected browser follows.')) {
      this.env.session.restoreDefaults();
    }
  }
}
