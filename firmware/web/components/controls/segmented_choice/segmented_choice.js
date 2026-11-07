import { Component, useState } from '../../../core/owl.js';
import { getPath } from '../../../core/store.js';

// Props: path, options [{ value, label, sub?, title? }], disabled?
export class SegmentedChoice extends Component {
  static template = 'owon.SegmentedChoice';
  static props = { path: String, options: Array, disabled: { type: Boolean, optional: true } };

  setup() {
    this.store = useState(this.env.store);
  }

  isPressed(option) {
    return String(getPath(this.store, this.props.path) === option.value);
  }

  choose(event) {
    const option = this.props.options[Number(event.currentTarget.dataset.index)];
    this.env.session.set(this.props.path, option.value);
  }
}
