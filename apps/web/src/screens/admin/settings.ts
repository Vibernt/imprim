import { html } from 'lit';
import { AdminRealmScreen } from './realm-screen';
import { cap, keyValues, mono, status } from './realm-ui';

interface Settings {
  realm: { id: string; display_name: string; issuer: string };
  role: 'realm' | 'platform';
  turnstile: 'on' | 'off' | 'misconfigured';
  delivery: Record<string, { pending: number }>;
  rate_limits: string;
}

const queues = [['Logout events', 'human'], ['Agent revocations', 'agent'], ['User events', 'user_events']] as const;
const turnstileTone = { on: 'success', off: 'neutral', misconfigured: 'danger' } as const;

class RealmSettingsScreen extends AdminRealmScreen<Settings> {
  protected heading = 'Settings';
  protected override description = 'Read-only deployment configuration. Change it with a reviewed deployment.';
  protected endpoint() { return '/admin/api/settings'; }

  protected content(settings: Settings) {
    const { realm, role, turnstile, delivery } = settings;
    return html`<div class="fd-stack" data-gap="6">
      ${keyValues([['Realm', html`${realm.display_name} ${mono(realm.id)}`], ['Issuer', mono(realm.issuer)],
        ['Your role', cap(role)], ['Bot check (Turnstile)', status(cap(turnstile), turnstileTone[turnstile])],
        ...queues.map(([label, key]): [string, ReturnType<typeof status>] => {
          const count = delivery[key]?.pending ?? 0;
          return [label, status(count ? `${count} waiting` : 'None waiting', count ? 'warning' : 'success')];
        })], 3)}
      <section class="fd-stack" data-gap="3" aria-labelledby="configuration-title">
        <h2 class="fd-h2" id="configuration-title">Full configuration</h2>
        <pre class="fd-codeblock-body fd-code">${JSON.stringify(settings, null, 2)}</pre>
      </section>
    </div>`;
  }
}

customElements.define('screen-realm-settings', RealmSettingsScreen);
