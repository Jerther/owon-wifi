import { Component, useState } from '../../core/owl.js';
import { timeOptions } from '../../core/labels.js';
import { formatSi, samplingFor, timeRangeSeconds } from '../../scope_logic.js';
import { SliderField } from '../controls/slider_field/slider_field.js';
import { StepperSelect } from '../controls/stepper_select/stepper_select.js';
import { ToggleButton } from '../controls/toggle_button/toggle_button.js';

export class HorizontalPanel extends Component {
  static template = 'owon.HorizontalPanel';
  static components = { SliderField, StepperSelect, ToggleButton };

  setup() {
    this.store = useState(this.env.store);
  }

  get times() {
    return timeOptions();
  }

  get positionDisabled() {
    return samplingFor(this.store.settings.rateIndex).roll;
  }

  get positionText() {
    const { rateIndex, trigger } = this.store.settings;
    return formatSi((trigger.position - 0.5) * timeRangeSeconds(rateIndex), 's');
  }
}
