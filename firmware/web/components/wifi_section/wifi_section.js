import { Component, onMounted, useRef, useState } from '../../core/owl.js';
import { NetworkItem } from './network_item.js';

export class WifiSection extends Component {
  static template = 'owon.WifiSection';
  static components = { NetworkItem };

  setup() {
    this.state = useState({
      networks: [], scanMessage: '', ssid: '', password: '', showPassword: false, result: '',
    });
    this.passwordInput = useRef('password');
    onMounted(() => this.scan());
  }

  get passwordType() {
    return this.state.showPassword ? 'text' : 'password';
  }

  strongestPerName(networks) {
    const strongest = new Map();
    networks.filter((network) => network.ssid).forEach((network) => {
      const known = strongest.get(network.ssid);
      if (!known || network.rssi > known.rssi) {
        strongest.set(network.ssid, network);
      }
    });
    return [...strongest.values()].sort((a, b) => b.rssi - a.rssi);
  }

  async scan() {
    this.state.networks = [];
    this.state.scanMessage = 'Scanning...';
    try {
      const response = await fetch('/networks');
      if (response.ok) {
        this.state.networks = this.strongestPerName(await response.json());
        this.state.scanMessage = this.state.networks.length ? '' : 'No network found';
      } else {
        this.state.scanMessage = 'Scan failed, try again in a moment';
      }
    } catch (error) {
      this.state.scanMessage = 'Scan failed: device unreachable';
    }
  }

  chooseNetwork(network) {
    this.state.ssid = network.ssid;
    this.state.password = '';
    this.passwordInput.el.focus();
  }

  save() {
    this.send(this.state.ssid, this.state.password);
  }

  forget() {
    this.send('', '');
  }

  async send(ssid, password) {
    try {
      const response = await fetch('/wifi', { method: 'POST', body: JSON.stringify({ ssid, password }) });
      this.state.result = response.ok ? 'Saved' : `Failed: ${await response.text()}`;
    } catch (error) {
      this.state.result = 'Failed: device unreachable';
    }
  }
}
