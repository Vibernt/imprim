import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { card, setting } from '../page-layout';
import { AccountScreen, post, success } from './account-screen';
import { when, empty, list } from './access-view';
import { connectionRow } from './connection-row';
import type { LoadingPreset } from '../loading';
import { HeldRows } from '../held';
import { menuTrigger } from '../row-menu';

interface Access {
  sessions: { sid: string; method: string; auth_time: number; last_seen: number | null; device: string; location: string | null; current: boolean }[];
  apps: { client_id: string; name: string; signed_in: number; href: string | null }[];
  browsers: { hash: string; name: string; expires_at: number }[];
}

const method = (name: string) => ({ email: t('an email link'), password: t('a password'), passkey: t('a passkey'), github: 'GitHub', google: 'Google' })[name] ?? name;
const notices = () => ({ others: t('Signed out of other sessions'), session: t('Session signed out'), app: t('Signed out of the app'), browser: t('Browser forgotten') });

class ScreenSessions extends AccountScreen<Access> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'list', options: { rows: 4 } }];
  private readonly holds = new HeldRows(() => this.requestUpdate());
  protected override async read() {
    const data = await api<Access>('/v1/account/sessions');
    if (this.isConnected) {
      const url = new URL(location.href);
      const changed = url.searchParams.get('changed');
      const messages = notices();
      if (changed && Object.hasOwn(messages, changed)) {
        success(messages[changed as keyof typeof messages]);
        url.searchParams.delete('changed');
        history.replaceState(history.state, '', url);
      }
    }
    return data;
  }

  private end(id: string, title: string, path: string, body: object, notice: string, trigger = menuTrigger(id)) {
    this.holds.start(id, {
      title, run: send => post(path, body, send), failed: this.mutationError,
      done: async () => {
        if (!this.isConnected) return;
        success(notice);
        await this.load(false);
      },
    }, () => {
      void this.updateComplete.then(() => this.querySelector<HTMLElement>(`#${CSS.escape(trigger)}`)?.focus());
    });
  }

  protected override render() {
    return this.page(t('Sessions'), t('Where you’re signed in.'), ({ sessions, apps, browsers }) => {
      const bulkHeld = this.holds.has('others');
      const sessionHeld = sessions.some(session => this.holds.has(`session-${session.sid}`));
      return html`
      ${card(t('Signed-in sessions'), html`
        ${list(t('Signed-in sessions'), sessions, s => s.sid, s => {
          const id = `session-${s.sid}`;
          return connectionRow({
            id, title: s.device, busy: (bulkHeld && !s.current) || this.holds.has(id),
            description: [
              s.location,
              t('Signed in {time} with {method}', { time: when(s.auth_time * 1000), method: method(s.method) }),
              t('Active {time}', { time: when(s.last_seen) }),
            ].filter(Boolean).join(' · '),
            badge: s.current ? t('This browser') : undefined, badgeTone: 'success',
            actions: s.current ? [] : [{
              label: t('Sign out'), name: t('Sign out {device}', { device: s.device }), danger: true,
              run: () => this.end(id, t('Signing out {device}', { device: s.device }), 'sessions', { sid: s.sid }, t('Session signed out')),
            }],
          });
        })}
        ${sessions.length > 1 ? setting(t('Other sessions'), '', html`
          <button class="fd-btn" data-variant="outline" type="button" id="im-sign-out-others"
            ?disabled=${bulkHeld || sessionHeld}
            @click=${() => this.end('others', t('Signing out other sessions'), 'sessions', { sid: 'others' }, t('Signed out of other sessions'), 'im-sign-out-others')}>${t('Sign out other sessions')}</button>`) : nothing}
      `, t('Browsers signed in to your account.'))}
      ${card(t('Apps'), apps.length ? list(t('Apps'), apps, a => a.client_id, a => {
        const id = `app-${a.client_id}`;
        const signOut = () => this.end(id, t('Signing out of {name}', { name: a.name }), 'apps', { client_id: a.client_id }, t('Signed out of the app'));
        const signOutName = t('Sign out of {name}', { name: a.name });
        return connectionRow({
          id, title: a.name, description: t('Signed in {time}', { time: when(a.signed_in) }), busy: this.holds.has(id),
          actions: [
            ...(a.href ? [{ label: t('Open'), name: t('Open {name}', { name: a.name }), href: a.href, document: true }] : []),
            { label: t('Sign out'), name: signOutName, run: signOut, danger: true },
          ],
        });
      }) : empty(t('No apps yet')), t('Signing out of an app ends its session on every device.'))}
      ${card(t('Remembered browsers'), browsers.length ? list(t('Remembered browsers'), browsers, d => d.hash, d => {
        const id = `browser-${d.hash}`;
        return connectionRow({
          id, title: d.name, busy: this.holds.has(id), description: t('Remembered until {date}', { date: when(d.expires_at) }),
          actions: [{ label: t('Forget'), name: t('Forget {name}', { name: d.name }), danger: true,
            run: () => this.end(id, t('Forgetting {name}', { name: d.name }), 'devices', { device: d.hash }, t('Browser forgotten')) }],
        });
      }) : empty(t('No remembered browsers')), t('These skip the verification code until the date shown.'))}`;
    });
  }
}
customElements.define('screen-sessions', ScreenSessions);
