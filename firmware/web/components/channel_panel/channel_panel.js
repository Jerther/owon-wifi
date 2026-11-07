import { Component, useState } from '../../core/owl.js';
import { rangeOptions } from '../../core/labels.js';
import { SegmentedChoice } from '../controls/segmented_choice/segmented_choice.js';
import { SliderField } from '../controls/slider_field/slider_field.js';
import { StepperSelect } from '../controls/stepper_select/stepper_select.js';
import { ToggleButton } from '../controls/toggle_button/toggle_button.js';

// Prop: index (0 for CH1, 1 for CH2)
export class ChannelPanel extends Component {
  static template = 'owon.ChannelPanel';
  static components = { SegmentedChoice, SliderField, StepperSelect, ToggleButton };
  static props = { index: Number };
  static COUPLINGS = [
    { value: 1, label: 'DC' },
    { value: 0, label: 'AC' },
    { value: 2, label: 'GND', sub: 'soft', title: 'Display only: the input stays connected' },
  ];
  static PROBES = [1, 10, 100].map((probe) => ({ value: probe, label: `×${probe}` }));

  setup() {
    this.store = useState(this.env.store);
  }

  get channel() {
    return this.store.settings.channels[this.props.index];
  }

  get title() {
    return `CH${this.props.index + 1}`;
  }

  get toneClass() {
    return `c${this.props.index}`;
  }

  get path() {
    return `settings.channels.${this.props.index}`;
  }

  get ranges() {
    return rangeOptions(this.channel.probe);
  }

  get offsetText() {
    return `${(this.channel.offset * 10).toFixed(1)} div`;
  }

  get lastOneOn() {
    const other = this.store.settings.channels[1 - this.props.index];
    return this.channel.on && !other.on;
  }
}
