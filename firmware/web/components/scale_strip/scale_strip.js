import { Component, useState } from '../../core/owl.js';
import { COUPLING_NAMES, rangeLabel, timeLabel } from '../../core/labels.js';
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
    const channel = this.store.settings.channels[index];
    return `CH${index + 1} ${rangeLabel(channel.rangeIndex, channel.probe)} ${COUPLING_NAMES[channel.coupling]}`;
  }

  get timeText() {
    return timeLabel(this.store.settings.rateIndex);
  }

  get fidelityText() {
    const { level, ratio } = this.status.fidelity;
    return `Trace ${level}: ${ratio} samples/period`;
  }

  get fidelityTitle() {
    const { ratio } = this.status.fidelity;
    return `The scope samples only ${ratio} times per signal period. About 10 gives a faithful trace; below 2.5 it may be aliased.`;
  }
}
