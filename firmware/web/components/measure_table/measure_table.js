import { Component, useState } from '../../core/owl.js';
import { formatSiPrecise, formatVoltsForChannel } from '../../scope_logic.js';

export class MeasureTable extends Component {
  static template = 'owon.MeasureTable';
  static ROWS = [
    { label: 'Frequency', key: 'frequency', unit: 'Hz' },
    { label: 'Vpp', key: 'vpp', unit: 'V' },
    { label: 'Vmax', key: 'vmax', unit: 'V' },
    { label: 'Vmin', key: 'vmin', unit: 'V' },
    { label: 'Vavg', key: 'vavg', unit: 'V' },
    { label: 'Vrms', key: 'vrms', unit: 'V' },
  ];
  static CHANNELS = [0, 1];

  setup() {
    this.status = useState(this.env.session.status);
    this.store = useState(this.env.store);
  }

  valueText(channel, row) {
    const result = this.status.measures[channel];
    const value = result ? result[row.key] : null;
    const known = value !== null && !(row.key === 'frequency' && value <= 0);
    let text = '-';
    if (known && row.unit === 'V') {
      text = formatVoltsForChannel(value, this.store.settings.channels[channel]);
    } else if (known) {
      text = formatSiPrecise(value, row.unit);
    }
    return text;
  }
}
