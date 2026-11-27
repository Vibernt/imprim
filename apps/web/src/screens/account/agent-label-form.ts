import { html } from 'lit';
import { t } from '../../lib/i18n';

export function agentLabelForm(grantId: string, label: string | null, pending: boolean,
  save: (event: SubmitEvent) => void, cancel: () => void) {
  const id = `agent-label-${grantId}`;
  return html`<form class="fd-form" method="post" @submit=${save}>
    <div class="fd-field">
      <label class="fd-field-label" for=${id}>${t('Connection name')}</label>
      <input class="fd-input" id=${id} name="label" type="text" value=${label ?? ''}
        aria-describedby=${id + '-hint'} ?disabled=${pending}>
      <p class="fd-field-hint" id=${id + '-hint'}>${t('Shown only to you.')}</p>
    </div>
    <div class="fd-form-actions">
      <button class="fd-btn" data-variant="primary" type="submit" ?disabled=${pending}>${t('Save')}</button>
      <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${cancel}>${t('Cancel')}</button>
    </div>
  </form>`;
}
