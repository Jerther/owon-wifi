import { Component, useState } from '../../core/owl.js';
import { RUN, SINGLE, STOP } from '../../core/scope_session.js';

export class ActionBar extends Component {
  static template = 'owon.ActionBar';

  setup() {
    this.status = useState(this.env.session.status);
  }

  get running() {
    return this.status.acquire === RUN;
  }

  get runLabel() {
    return this.running ? 'Stop' : 'Run';
  }

  get runTone() {
    return this.running ? 'bad' : 'ok';
  }

  get singleTone() {
    return this.status.acquire === SINGLE ? 'warn' : '';
  }

  get forceDisabled() {
    return this.status.acquire === STOP;
  }

  toggleRun() {
    this.env.session.toggleRun();
  }

  single() {
    this.env.session.single();
  }

  forceTrigger() {
    this.env.session.forceTrigger();
  }

  autoset() {
    this.env.session.autoset();
  }
}
