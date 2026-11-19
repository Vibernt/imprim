import { api } from './api';

type Vars = Record<string, string | number>;
type Forms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type Catalogue = Record<string, string | Forms>;
let catalogue: Catalogue = {};
let rules = new Intl.PluralRules('en');

export async function loadI18n(locale: string): Promise<void> {
  catalogue = await api<Catalogue>(`/v1/i18n/${encodeURIComponent(locale)}.json`);
  rules = new Intl.PluralRules(locale);
}

const lookup = (id: string) => Object.hasOwn(catalogue, id) ? catalogue[id] : undefined;
const fill = (text: string, vars: Vars) => text.replace(/\{([a-z][a-z0-9_]*)\}/gi, (token, key: string) =>
  Object.hasOwn(vars, key) ? String(vars[key]) : token);

export function t(id: string, vars: Vars = {}): string {
  const message = lookup(id);
  return fill(typeof message === 'string' ? message : id, vars);
}

export function tPlural(count: number, one: string, other: string, vars: Vars = {}): string {
  const forms = lookup(other);
  const message = typeof forms === 'object' ? forms[rules.select(count)] ?? forms.other
    : forms ?? (count === 1 ? one : other);
  return fill(message, { count, ...vars });
}
