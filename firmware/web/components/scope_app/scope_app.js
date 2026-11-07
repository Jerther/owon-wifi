import { Component, useState } from '../../core/owl.js';
import { formatSi, samplingFor } from '../../scope_logic.js';
import { ActionBar } from '../action_bar/action_bar.js';
import { ChannelPanel } from '../channel_panel/channel_panel.js';
import { HorizontalPanel } from '../horizontal_panel/horizontal_panel.js';
import { InfoLine } from '../info_line/info_line.js';
import { MeasureTable } from '../measure_table/measure_table.js';
import { ScaleStrip } from '../scale_strip/scale_strip.js';
import { ScopeScreen } from '../scope_screen/scope_screen.js';
import { StatusPill } from '../status_pill/status_pill.js';
import { TriggerPanel } from '../trigger_panel/trigger_panel.js';
import { ViewPanel } from '../view_panel/view_panel.js';

export class ScopeApp extends Component {
  static template = 'owon.ScopeApp';
  static components = {
    ActionBar, ChannelPanel, HorizontalPanel, InfoLine, MeasureTable, ScaleStrip, ScopeScreen, StatusPill,
    TriggerPanel, ViewPanel,
  };

  setup() {
    this.store = useState(this.env.store);
    this.status = useState(this.env.session.status);
  }

  get sampleInfo() {
    const settings = this.store.settings;
    const sampling = samplingFor(settings.rateIndex);
    const roll = sampling.roll ? ' roll' : '';
    const interpolated = sampling.interpolated ? ' sin(x)/x' : '';
    const peak = settings.peak ? ' peak' : '';
    return `${formatSi(sampling.rate, 'S/s')}${roll}${interpolated}${peak}`;
  }
}
