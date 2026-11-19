import { html } from 'lit';
import { field } from '../realm-ui';
import { assets, languages, type Branding, type Look } from './types';

const names = [
  ['name', 'Name', 'Acme', 'Shown beside the mark, in page titles and in emails.'],
  ['legal_name', 'Legal name', 'Acme Ltd', 'Shown in the footer and emails.'],
  ['support_email', 'Support email', 'help@acme.com'],
  ['support_url', 'Help URL', 'https://acme.com/help', 'Used instead of the support email in the footer.'],
  ['privacy_url', 'Privacy URL', 'https://acme.com/privacy'],
  ['terms_url', 'Terms URL', 'https://acme.com/terms'],
] as const;
const words = [
  ['sign_in_heading', 'Sign-in heading', 'Sign in to Acme'],
  ['sign_in_help', 'Sign-in line', 'Use your work email.'],
  ['consent_intro', 'Agent consent line', 'Agents act as you, within the scopes below.'],
  ['signed_out', 'Signed-out line', 'See you soon.'],
  ['footer', 'Footer line', 'Acme accounts run on Imprim.'],
] as const;

export const nameFields = (brand: Branding) => names.map(([name, label, placeholder, hint]) =>
  field('branding-' + name, label, { name, placeholder, value: brand[name], hint,
    type: name.endsWith('_url') ? 'url' : name === 'support_email' ? 'email' : 'text' }));

export function languageFields(brand: Branding) {
  const current = brand.locale ?? '';
  const offered = brand.locales ?? languages.map(([tag]) => tag);
  const options = [['', 'English, unless a browser asks for another'], ...languages.map(([tag, name]) => [tag, `${name} (${tag})`])];
  if (current && !options.some(([tag]) => tag === current)) options.push([current, current]);
  return html`<div class="fd-stack" data-gap="4">
    <div class="fd-field">
      <label class="fd-field-label" for="branding-locale">Default language</label>
      <span class="fd-select"><select id="branding-locale" name="locale" aria-describedby="branding-locale-hint">
        ${options.map(([value, label]) => html`<option value=${value} ?selected=${value === current}>${label}</option>`)}
      </select></span>
      <p class="fd-field-hint" id="branding-locale-hint">Pages and emails use it if the browser asks for a language you don’t offer.</p>
    </div>
    <fieldset class="fd-stack im-fieldset" data-gap="2">
      <legend class="fd-field-label">Offered languages</legend>
      ${languages.map(([tag, name]) => html`<label class="fd-checkbox">
        <input type="checkbox" name="locales" value=${tag} .checked=${offered.includes(tag)}>
        <span class="fd-checkbox-box"></span><span class="fd-checkbox-label">${name} (${tag})</span>
      </label>`)}
    </fieldset>
  </div>`;
}

const wordFields = (prefix: string, values: Record<string, string>) => words.map(([key, label, placeholder]) =>
  field('branding-' + prefix + '-' + key, label, { name: prefix + '.' + key, value: values[key], max: 300, placeholder }));

export const copyFields = (brand: Branding) => html`
  <div class="fd-stack" data-gap="4">
    ${wordFields('copy', brand.copy ?? {})}
    ${languages.map(([tag, label]) => html`<details class="fd-disclosure">
      <summary class="fd-disclosure-trigger">${label} (${tag})</summary>
      <div class="fd-disclosure-panel"><div class="fd-disclosure-inner fd-stack" data-gap="3">
        ${wordFields('locale_copy.' + tag, brand.locale_copy?.[tag] ?? {})}
      </div></div>
    </details>`)}
  </div>`;

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export function collect(form: FormData, brand: Branding, look: Look): Branding {
  const result: Branding = {};
  for (const [key] of names) {
    const value = text(form, key);
    if (value) result[key] = value;
  }
  for (const key of assets) if (brand[key]) result[key] = brand[key];
  const locale = text(form, 'locale');
  if (locale) result.locale = locale;
  const offered = form.getAll('locales').map(String);
  if (offered.length < languages.length) result.locales = offered;
  const copyIn = (prefix: string) => Object.fromEntries(words.map(([key]) =>
    [key, text(form, prefix + '.' + key)]).filter(([, value]) => value));
  const copy = copyIn('copy');
  if (Object.keys(copy).length) result.copy = copy;
  const localeCopy = languages.map(([tag]) => [tag, copyIn('locale_copy.' + tag)] as const).filter(([, value]) => Object.keys(value).length);
  if (localeCopy.length) result.locale_copy = Object.fromEntries(localeCopy);
  if (Object.keys(look).length) result.look = look;
  return result;
}
