import { Component, useState } from '../../core/owl.js';
import { MEASURES, measureText } from '../../core/labels.js';

export class MeasureTable extends Component {
  static template = 'owon.MeasureTable';
  static ROWS = MEASURES;
  static CHANNELS = [0, 1];

  setup() {
    this.status = useState(this.env.session.status);
    this.store = useState(this.env.store);
  }

  valueText(channel, row) {
    return measureText(this.status.measures[channel], row, this.store.settings.channels[channel]);
  }
}
