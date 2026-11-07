import { Component, onMounted, onPatched, onWillUnmount, useRef, useState } from '../../core/owl.js';

export class LogSection extends Component {
  static template = 'owon.LogSection';
  static periodMs = 2000;
  static bottomMarginPx = 20;

  setup() {
    this.state = useState({ text: '' });
    this.box = useRef('box');
    this.timer = null;
    this.followBottom = false;
    onMounted(() => {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), LogSection.periodMs);
    });
    onPatched(() => this.scrollIfFollowing());
    onWillUnmount(() => clearInterval(this.timer));
  }

  get isAtBottom() {
    const box = this.box.el;
    return box.scrollTop + box.clientHeight >= box.scrollHeight - LogSection.bottomMarginPx;
  }

  scrollIfFollowing() {
    if (this.followBottom) {
      this.box.el.scrollTop = this.box.el.scrollHeight;
      this.followBottom = false;
    }
  }

  async refresh() {
    try {
      const text = await (await fetch('/logs')).text();
      this.followBottom = this.isAtBottom;
      this.state.text = text;
    } catch (error) {
      // The next poll will try again.
    }
  }
}
