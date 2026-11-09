import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/views.css';
import { mountApp } from './app';
import { applyTheme, loadThemePref, parseHash, Store } from './state';

const theme = loadThemePref();
const store = new Store({
  session: null,
  stored: null,
  theme,
  mode: applyTheme(theme),
  route: parseHash(location.hash),
});

mountApp(document.getElementById('app')!, store);
