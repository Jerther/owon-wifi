import { Component, useState } from '../../../core/owl.js';
import { getPath } from '../../../core/store.js';

// Props: label, path, min, max, step, text (value shown at the right), disabled?
export class SliderField extends Component {
  static template = 'owon.SliderField';
  static props = {
    label: String,
    path: String,
    min: Number,
    max: Number,
    step: Number,
    text: String,
    disabled: { type: Boolean, optional: true },
  };

  setup() {
    this.store = useState(this.env.store);
  }

  get value() {
    return getPath(this.store, this.props.path);
  }

  change(event) {
    this.env.session.set(this.props.path, Number(event.target.value));
  }
}
