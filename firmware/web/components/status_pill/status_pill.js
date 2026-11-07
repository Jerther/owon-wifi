import { Component, useState } from '../../core/owl.js';

export class StatusPill extends Component {
  static template = 'owon.StatusPill';
  static DISPLAYS = {
    offline: { text: 'No connection', tone: 'bad' },
    connecting: { text: 'Waiting for the scope', tone: 'warn' },
    autoset: { text: 'Autoset...', tone: 'ok' },
    auto: { text: 'Running (auto)', tone: 'ok' },
    roll: { text: 'Running (roll)', tone: 'ok' },
    triggered: { text: 'Running (triggered)', tone: 'ok' },
    awaiting: { text: 'Waiting for trigger', tone: 'warn' },
    armed: { text: 'Single: waiting for trigger', tone: 'warn' },
    filling: { text: 'Single: capturing', tone: 'ok' },
    stopped: { text: 'Stopped', tone: 'neutral' },
    captured: { text: 'Single captured', tone: 'neutral' },
  };

  setup() {
    this.status = useState(this.env.session.status);
  }

  get display() {
    return this.constructor.DISPLAYS[this.status.state] || this.constructor.DISPLAYS.offline;
  }

  get text() {
    const captured = this.status.state === 'captured';
    return captured ? `${this.display.text} (${this.status.singleCount})` : this.display.text;
  }
}
