import { Component } from '../../core/owl.js';

export class NetworkItem extends Component {
  static template = 'owon.NetworkItem';
  static props = { network: Object, onChoose: Function };

  get label() {
    const { ssid, secure, rssi } = this.props.network;
    return `${ssid}${secure ? '' : ' (open)'} · ${rssi} dBm`;
  }

  choose() {
    this.props.onChoose(this.props.network);
  }
}
