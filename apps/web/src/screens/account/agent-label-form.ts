import { html } from 'lit';
import { t } from '../../lib/i18n';
import { fieldWithAction } from '../page-layout';

export function agentLabelForm(grantId: string, label: string | null, pending: boolean,
  save: (event: SubmitEvent) => void, cancel: () => void) {
  const id = `agent-label-${grantId}`;
  return html`<form class="fd-form" method="post" @submit=${save}>
    ${fieldWithAction(id, t('Connection name'), t('Shown only to you.'), html`
      <input class="fd-input fd-grow" id=${id} name="label" type="text" value=${label ?? ''}
        aria-describedby=${id + '-hint'} ?disabled=${pending}>`,
    // Save and Cancel sit together beside the field: one short edit, not a form with its own footer.
    html`<button class="fd-btn" data-variant="primary" type="submit" ?disabled=${pending}>${t('Save')}</button>
      <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${cancel}>${t('Cancel')}</button>`)}
  </form>`;
}
