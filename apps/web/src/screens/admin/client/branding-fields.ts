import { html } from 'lit';
import { languages } from '../branding/types';
import { advanced, jsonField, text } from '../core-fields';
import type { ClientBranding } from './model';

const summaryField = (name: string, label: string, value?: string) => text({
  id: 'client-' + name, name, label, value, maxlength: 80, placeholder: 'Manage your team’s notes',
});

const summaryName = (tag: string) => 'summary-' + tag;

export function clientBrandingFields(branding: ClientBranding) {
  const { summary, locale_copy: localeCopy, ...advancedBranding } = branding;
  const overrides = Object.fromEntries(Object.entries(localeCopy ?? {}).flatMap(([tag, { summary: _, ...copy }]) =>
    Object.keys(copy).length ? [[tag, copy]] : []));
  return html`
    ${summaryField('summary', 'App description', summary)}
    ${advanced('Description by language', html`<div class="fd-stack" data-gap="3">
      ${languages.map(([tag, label]) => summaryField(summaryName(tag), label, localeCopy?.[tag]?.summary))}
    </div>`)}
    ${advanced('Override branding', jsonField({ id: 'f-branding', label: 'Branding', name: 'branding',
      value: { ...advancedBranding, ...(Object.keys(overrides).length ? { locale_copy: overrides } : {}) },
      hint: 'Override this app’s name, look, sign-in copy, links and logos.' }))}
  `;
}

export function collectClientBranding(data: FormData): ClientBranding {
  const json: unknown = JSON.parse(String(data.get('branding')));
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError('Branding must be an object.');
  const branding: ClientBranding = { ...json };
  const summary = String(data.get('summary') ?? '').trim();
  if (summary) branding.summary = summary;
  else delete branding.summary;
  const local = branding.locale_copy ?? {};
  if (branding.locale_copy !== undefined && (!branding.locale_copy || typeof branding.locale_copy !== 'object' || Array.isArray(branding.locale_copy) ||
    Object.values(local).some(copy => !copy || typeof copy !== 'object' || Array.isArray(copy)))) {
    throw new SyntaxError('Branding language overrides must be objects.');
  }
  for (const [tag] of languages) {
    const translated = String(data.get(summaryName(tag)) ?? '').trim();
    if (translated) local[tag] = { ...local[tag], summary: translated };
  }
  if (Object.keys(local).length) branding.locale_copy = local;
  else delete branding.locale_copy;
  return branding;
}
