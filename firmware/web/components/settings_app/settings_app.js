import { Component } from '../../core/owl.js';
import { AppearanceSection } from '../appearance_section/appearance_section.js';
import { FirmwareSection } from '../firmware_section/firmware_section.js';
import { LogSection } from '../log_section/log_section.js';
import { StatusSection } from '../status_section/status_section.js';
import { WifiSection } from '../wifi_section/wifi_section.js';

export class SettingsApp extends Component {
  static template = 'owon.SettingsApp';
  static components = { AppearanceSection, FirmwareSection, LogSection, StatusSection, WifiSection };
}
