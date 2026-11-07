import { Component, useState } from '../../../core/owl.js';
import { getPath } from '../../../core/store.js';

// Props: path (option index in the store), options [{ value, label }], label (aria label of the select),
// minusDelta? (index change of the "-" button, -1 by default; "+" moves the other way),
// minusLabel?, plusLabel? (aria labels of the buttons).
export class StepperSelect extends Component {
  static template = 'owon.StepperSelect';
  static props = {
    path: String,
    options: Array,
    label: String,
    minusDelta: { type: Number, optional: true },
    minusLabel: { type: String, optional: true },
    plusLabel: { type: String, optional: true },
  };
  static defaultProps = { minusDelta: -1, minusLabel: 'Decrease', plusLabel: 'Increase' };

  setup() {
    this.store = useState(this.env.store);
  }

  get value() {
    return getPath(this.store, this.props.path);
  }

  stepMinus() {
    this.env.session.step(this.props.path, this.props.minusDelta, this.props.options.length);
  }

  stepPlus() {
    this.env.session.step(this.props.path, -this.props.minusDelta, this.props.options.length);
  }

  select(event) {
    this.env.session.set(this.props.path, Number(event.target.value));
  }
}
