import { html } from 'lit';
import { card, codeBlock, setting } from '../page-layout';
import { advanced } from './core-fields';
import { AdminRealmScreen } from './realm-screen';
import { cap, keyValues, mono, status, when } from './realm-ui';

type QueueStatus = { pending: number; oldest: number | null };

interface Settings {
  realm: { id: string; display_name: string; issuer: string };
  role: 'realm' | 'platform';
  turnstile: 'on' | 'off' | 'misconfigured';
  delivery: {
    human: QueueStatus; agent: QueueStatus; user_events: QueueStatus;
    workspace_events: QueueStatus; clients_missing_backchannel: string[];
  };
  rate_limits: string;
}

const queues = [['Logout events', 'human'], ['Agent revocations', 'agent'], ['User events', 'user_events'],
  ['Workspace events', 'workspace_events']] as const;
const turnstileTone = { on: 'success', off: 'neutral', misconfigured: 'danger' } as const;

class RealmSettingsScreen extends AdminRealmScreen<Settings> {
  protected heading = 'Configuration';
  protected override get description() { return 'Read-only deployment configuration.'; }
  protected endpoint() { return '/admin/api/settings'; }

  protected content(settings: Settings) {
    const { realm, role, turnstile, delivery } = settings;
    const missing = delivery.clients_missing_backchannel;
    return html`<div class="fd-stack" data-gap="6">
      ${keyValues([['Realm', html`${realm.display_name} ${mono(realm.id)}`], ['Issuer', mono(realm.issuer)], ['Your role', cap(role)]], 3)}
      ${card('Deployment', html`
        ${setting('Bot check (Turnstile)', '', status(cap(turnstile), turnstileTone[turnstile]))}
        ${setting('Rate limits', settings.rate_limits, status('Deployment managed', 'neutral'))}
      `)}
      ${card('Back-channel delivery', html`
        ${queues.map(([label, key]) => {
          const { pending: count, oldest } = delivery[key];
          return setting(label, oldest === null ? '' : 'Oldest event from ' + when(oldest), status(count ? `${count} waiting` : 'None waiting', count ? 'warning' : 'success'));
        })}
        ${setting('Clients with events missing a back-channel URL',
          missing.length ? html`<span class="im-breakable">${missing.join(', ')}</span>` : '',
          status(missing.length ? String(missing.length) : 'None', missing.length ? 'warning' : 'success'))}
      `)}
      ${advanced('Raw configuration', codeBlock('Raw configuration', settings))}
    </div>`;
  }
}

customElements.define('screen-realm-settings', RealmSettingsScreen);
