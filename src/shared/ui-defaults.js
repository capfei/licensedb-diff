export const UI_DEFAULTS = Object.freeze({
  theme: 'light',
  scanFilter: 'both',
  includeDeprecated: false,
  scanSource: 'both',
  includeRules: true
});

export const BADGE_STYLES = Object.freeze({
  green: Object.freeze({ text: 'DEV', color: '#4CAF50' }),
  red: Object.freeze({ text: 'Error', color: '#F44336' }),
  orange: Object.freeze({ text: 'Load', color: '#FF8C00' })
});

export const BADGE_DEFAULT = 'green';
