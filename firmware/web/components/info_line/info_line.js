import { Component, useState } from '../../core/owl.js';
import { infoText } from '../../core/info_text.js';

export class InfoLine extends Component {
  static template = 'owon.InfoLine';

  setup() {
    this.store = useState(this.env.store);
    this.status = useState(this.env.session.status);
  }

  get text() {
    return infoText(this.store, this.status);
  }
}
