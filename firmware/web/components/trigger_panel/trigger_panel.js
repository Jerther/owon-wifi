import { Component, useState } from '../../core/owl.js';
import { EXT, formatSi, voltsPerDivision } from '../../scope_logic.js';
import { SegmentedChoice } from '../controls/segmented_choice/segmented_choice.js';
import { SliderField } from '../controls/slider_field/slider_field.js';

export class TriggerPanel extends Component {
  static template = 'owon.TriggerPanel';
  static components = { SegmentedChoice, SliderField };
  static SWEEPS = [{ value: 0, label: 'Auto' }, { value: 1, label: 'Normal' }];
  static SOURCES = [{ value: 0, label: 'CH1' }, { value: 1, label: 'CH2' }, { value: 2, label: 'EXT' }];
  static SLOPES = [{ value: false, label: 'Rising' }, { value: true, label: 'Falling' }];

  setup() {
    this.store = useState(this.env.store);
  }

  get levelDisabled() {
    return this.store.settings.trigger.source === EXT;
  }

  get levelText() {
    const { channels, trigger } = this.store.settings;
    const source = channels[trigger.source];
    return source ? formatSi(trigger.levelDiv * voltsPerDivision(source), 'V') : '-';
  }

  setLevelToMiddle() {
    this.env.session.setLevelToMiddle();
  }
}
