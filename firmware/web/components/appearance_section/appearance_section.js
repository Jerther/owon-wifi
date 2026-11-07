import { Component, useState } from '../../core/owl.js';
import { THEME_CHOICES, loadThemeChoice, saveThemeChoice } from '../../core/theme.js';

export class AppearanceSection extends Component {
  static template = 'owon.AppearanceSection';

  setup() {
    this.choices = THEME_CHOICES;
    this.state = useState({ choice: loadThemeChoice() });
  }

  choose(event) {
    this.state.choice = event.currentTarget.dataset.choice;
    saveThemeChoice(this.state.choice);
  }

  isChosen(choice) {
    return this.state.choice === choice;
  }
}
