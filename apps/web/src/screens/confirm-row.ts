import { html, nothing, type TemplateResult } from 'lit';

export const confirmRowId = (id: string) => 'im-confirm-' + id;

interface Phrase {
  value: string;
  label: string;
  rule?: string;
  trim?: boolean;
}

export interface ConfirmRowCopy {
  id: string;
  text: string;
  action: string;
  cancelLabel?: string;
  phrase?: Phrase;
  detail?: TemplateResult;
  table?: boolean;
}

const submitButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-fd-confirm-row-submit]')!;
export const phraseInput = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input');

export function matchesPhrase(input: HTMLInputElement, phrase: Phrase) {
  return (phrase.trim ? input.value.trim() : input.value) === phrase.value;
}

function phraseField(id: string, phrase: Phrase, pending: boolean) {
  const inputId = id + '-phrase';
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${inputId}>${phrase.label}</label>
    <input class="fd-input" id=${inputId} autocomplete="off" spellcheck="false" autocapitalize="off"
      aria-describedby=${inputId + '-rule'} ?readonly=${pending}
      @input=${(event: Event) => {
        const input = event.currentTarget as HTMLInputElement;
        submitButton(input.closest<HTMLElement>('.fd-confirm-row')!).disabled = !matchesPhrase(input, phrase);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        const input = event.currentTarget as HTMLInputElement;
        if (matchesPhrase(input, phrase)) submitButton(input.closest<HTMLElement>('.fd-confirm-row')!).click();
      }}>
    <p class="fd-field-hint" id=${inputId + '-rule'}>${phrase.rule ?? html`Type <code class="fd-code"><span class="im-breakable">${phrase.value}</span></code> exactly as shown.`}</p>
  </div>`;
}

export function confirmRow(copy: ConfirmRowCopy, pending: boolean, opened: (row: HTMLElement) => void,
  closed: (row: HTMLElement) => void, confirmed: (event: Event, row: HTMLElement) => void) {
  const id = confirmRowId(copy.id);
  // This sets the initial visibility. Fire owns hidden, busy, the error and focus after that.
  return html`<div class="fd-confirm-row" id=${id} role="group" aria-labelledby=${id + '-text'} ?hidden=${!copy.table}
    @fd:open=${(event: Event) => {
      if (event.target !== event.currentTarget) return;
      const row = event.currentTarget as HTMLElement;
      const input = phraseInput(row);
      if (input) {
        input.value = '';
        submitButton(row).disabled = true;
      }
      opened(row);
    }}
    @fd:close=${(event: Event) => {
      if (event.target === event.currentTarget) closed(event.currentTarget as HTMLElement);
    }}
    @fd:confirm=${(event: Event) => {
      if (event.target === event.currentTarget) confirmed(event, event.currentTarget as HTMLElement);
    }}>
    <p class="fd-confirm-row-text" id=${id + '-text'}>${copy.text}</p>
    ${copy.phrase ? html`<div class="fd-stack" data-gap="2">
      ${copy.detail ?? nothing}
      ${phraseField(id, copy.phrase, pending)}
    </div>` : nothing}
    <p class="fd-confirm-row-error" role="alert" hidden></p>
    <div class="fd-confirm-row-actions">
      <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-fd-confirm-row-cancel>${copy.cancelLabel ?? 'Cancel'}</button>
      <button class="fd-btn" type="button" data-variant="danger" data-size="sm" data-fd-confirm-row-submit
        ?disabled=${Boolean(copy.phrase)}><span>${copy.action}</span></button>
    </div>
  </div>`;
}
