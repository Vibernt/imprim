import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { setting } from '../page-layout';
import { AccountScreen, post, success } from './account-screen';
import { when, empty, list, section } from './access-view';

interface Access {
  sessions: { sid: string; method: string; auth_time: number; last_seen: number | null; device: string; location: string | null; current: boolean }[];
  apps: { client_id: string; name: string; signed_in: number; href: string | null }[];
  browsers: { hash: string; name: string; expires_at: number }[];
}

const method = (name: string) => ({ email: t('an email link'), password: t('a password'), passkey: t('a passkey'), github: 'GitHub', google: 'Google' })[name] ?? name;
const notices = () => ({ others: t('Signed out of other sessions'), session: t('Session signed out'), app: t('Signed out of the app'), browser: t('Browser forgotten') });

class ScreenSessions extends AccountScreen<Access> {
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

  private end = (path: string, body: object, notice: string) => this.mutate(async () => {
    await post(path, body);
    if (!this.isConnected) return;
    success(notice);
    await this.load(false);
  });

  private action(label: string, name: string, run: () => void) {
    return html`<button class="fd-btn" data-variant="outline" data-size="sm" type="button" aria-label=${name} ?disabled=${this.pending} @click=${run}>${label}</button>`;
  }

  protected override render() {
    return this.page(t('Sessions and apps'), t('Where you’re signed in.'), ({ sessions, apps, browsers }) => html`
      ${section(t('Signed-in sessions'), t('Browsers signed in to your account.'), html`
        ${list(t('Signed-in sessions'), sessions.map(s => ({
          title: s.device, description: [s.location, t('Signed in {time} with {method}', { time: when(s.auth_time * 1000), method: method(s.method) })].filter(Boolean).join(' · '),
          meta: t('Active {time}', { time: when(s.last_seen) }),
          trail: s.current ? html`<span class="fd-badge" data-tone="success">${t('This browser')}</span>` :
            this.action(t('Sign out'), t('Sign out {device}', { device: s.device }), () => this.end('sessions', { sid: s.sid }, t('Session signed out'))),
        })))}
        ${sessions.length > 1 ? setting(t('Other sessions'), '', html`
          <button class="fd-btn" data-variant="outline" type="button" ?disabled=${this.pending}
            @click=${() => this.end('sessions', { sid: 'others' }, t('Signed out of other sessions'))}>${t('Sign out other sessions')}</button>`) : nothing}`)}
      ${section(t('Apps'), t('Signing out of an app ends its session on every device.'), apps.length ? list(t('Apps'), apps.map(a => ({
        title: a.name, description: t('Signed in {time}', { time: when(a.signed_in) }),
        trail: html`<div class="fd-row" data-wrap>
          ${a.href ? html`<a class="fd-btn" data-im-document data-variant="outline" data-size="sm" href=${a.href}
            aria-label=${t('Open {name}', { name: a.name })}>${t('Open')}</a>` : nothing}
          ${this.action(t('Sign out'), t('Sign out of {name}', { name: a.name }), () => this.end('apps', { client_id: a.client_id }, t('Signed out of the app')))}
        </div>`,
      }))) : empty(t('No apps yet')))}
      ${section(t('Remembered browsers'), t('These skip the second-factor code until the date shown.'), browsers.length ? list(t('Remembered browsers'), browsers.map(d => ({
        title: d.name, description: t('Remembered until {date}', { date: when(d.expires_at) }),
        trail: this.action(t('Forget'), t('Forget {name}', { name: d.name }), () => this.end('devices', { device: d.hash }, t('Browser forgotten'))),
      }))) : empty(t('No remembered browsers')))}`);
  }
}
customElements.define('screen-sessions', ScreenSessions);
