import 'fire-design/css';
import './fire-theme.css';
import './app.css';
import './shell/app-shell';

import { ApiError } from './lib/api';
import { loadI18n } from './lib/i18n';
import { startRouter } from './lib/router';
import { loadSession } from './lib/session';
import type { AppShell } from './shell/app-shell';
import { routes } from './routes';

const outlet = document.querySelector<AppShell>('app-shell')!;

async function start(): Promise<void> {
  try {
    const session = await loadSession();
    await loadI18n(session.locale);
    await startRouter({ routes, session, outlet, base: import.meta.env.BASE_URL,
      title: (title) => `${title} · ${session.realm.display_name}` });
  } catch (error) {
    if (!(error instanceof ApiError && error.redirecting)) outlet.startupFailed = true;
  }
}

void start();
