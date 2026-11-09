import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/views.css';
import { mountApp } from './app';
import { openSession, type Opened } from './sessions';
import { applyTheme, loadThemePref, parseHash, Store, tabSession } from './state';

const theme = loadThemePref();
const mode = applyTheme(theme);

/** After a reload, reopen the session this tab had open (when its files are kept in the browser). */
async function reopen(): Promise<Opened | null> {
  const id = tabSession.get();
  if (!id) return null;
  try {
    return await openSession(id);
  } catch {
    tabSession.set(null);
    return null;
  }
}

void reopen().then((opened) => {
  const store = new Store({
    session: opened?.session ?? null,
    stored: opened?.stored ?? null,
    theme,
    mode,
    route: parseHash(location.hash),
  });
  mountApp(document.getElementById('app')!, store);
});
