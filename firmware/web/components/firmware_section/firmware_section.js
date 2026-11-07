import { Component, useRef, useState } from '../../core/owl.js';

export class FirmwareSection extends Component {
  static template = 'owon.FirmwareSection';

  setup() {
    this.state = useState({ result: '' });
    this.fileInput = useRef('file');
  }

  async upload() {
    const file = this.fileInput.el.files[0];
    if (file) {
      await this.send(file);
    } else {
      this.state.result = 'Choose a .bin file first';
    }
  }

  async send(file) {
    this.state.result = 'Uploading...';
    try {
      const response = await fetch('/update', { method: 'POST', body: file });
      this.state.result = response.ok ? 'Done, restarting...' : `Failed: ${await response.text()}`;
    } catch (error) {
      this.state.result = 'Failed: connection lost';
    }
  }
}
