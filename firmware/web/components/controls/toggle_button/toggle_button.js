import { Component, useState } from '../../../core/owl.js';
import { getPath } from '../../../core/store.js';

// Props: path (boolean in the store), label, disabled?
export class ToggleButton extends Component {
  static template = 'owon.ToggleButton';
  static props = { path: String, label: String, disabled: { type: Boolean, optional: true } };

  setup() {
    this.store = useState(this.env.store);
  }

  get pressed() {
    return String(getPath(this.store, this.props.path) === true);
  }

  toggle() {
    this.env.session.set(this.props.path, getPath(this.store, this.props.path) !== true);
  }
}
