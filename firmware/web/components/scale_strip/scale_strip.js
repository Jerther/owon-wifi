import { Component, useState } from '../../core/owl.js';
import { channelLabel, timeLabel } from '../../core/labels.js';
import { DisplayPopover } from '../display_popover/display_popover.js';

export class ScaleStrip extends Component {
  static template = 'owon.ScaleStrip';
  static components = { DisplayPopover };
  static CHANNELS = [0, 1];

  setup() {
    this.store = useState(this.env.store);
    this.status = useState(this.env.session.status);
  }

  channelOn(index) {
    return this.store.settings.channels[index].on;
  }

  channelText(index) {
    return channelLabel(index, this.store.settings.channels[index]);
  }

  get timeText() {
    return timeLabel(this.store.settings.rateIndex);
  }

  get fidelityText() {
    const { level, ratio } = this.status.fidelity;
    return `Trace ${level}: ${ratio} samples/period`;
  }

  savePng() {
    this.env.session.savePng();
  }

  get fidelityTitle() {
    const { ratio } = this.status.fidelity;
    return `The scope samples only ${ratio} times per signal period. About 10 gives a faithful trace; below 2.5 it may be aliased.`;
  }
}
