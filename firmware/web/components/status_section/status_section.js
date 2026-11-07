import { Component, onMounted, onWillUnmount, useState } from '../../core/owl.js';

export class StatusSection extends Component {
  static template = 'owon.StatusSection';
  static periodMs = 5000;
  static failureNoNetwork = 201;
  static failuresWrongPassword = [2, 15, 202, 204];

  setup() {
    this.state = useState({ info: null, unreachable: false });
    this.timer = null;
    onMounted(() => {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), StatusSection.periodMs);
    });
    onWillUnmount(() => clearInterval(this.timer));
  }

  async refresh() {
    try {
      this.state.info = await (await fetch('/status')).json();
      this.state.unreachable = false;
    } catch (error) {
      this.state.unreachable = true;
    }
  }

  get firmwareText() {
    const { version, partition } = this.state.info;
    return `${version} (${partition})`;
  }

  get joinedText() {
    const info = this.state.info;
    return `${info.sta_ssid || 'none'}, ${this.describeConnection(info)}`;
  }

  describeConnection(info) {
    let description = 'not connected';
    if (info.connected) {
      description = `connected, ${info.ip}`;
    } else if (StatusSection.failuresWrongPassword.includes(info.last_failure)) {
      description = 'not connected, check the password';
    } else if (info.last_failure === StatusSection.failureNoNetwork) {
      description = 'not connected, network not found';
    } else if (info.last_failure) {
      description = `not connected, error ${info.last_failure}`;
    }
    return description;
  }
}
