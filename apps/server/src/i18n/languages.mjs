// The languages Imprim ships, and the small pieces every module may need without importing the catalogues: tag
// parsing and placeholder filling. English is the source language: the English text in code is each message's id.
export const LANGUAGES = Object.freeze(['en', 'es', 'fr', 'de', 'pt-BR']);
// Each language's own name, for the account page's language choice.
export const LANGUAGE_NAMES = Object.freeze({ en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', 'pt-BR': 'Português (Brasil)' });
// A BCP 47 tag in the shape browsers and apps send: a 2–3 letter language, then subtags of 1–8 letters or digits.
// Anything else is not a language tag and is dropped, never reflected.
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
export function canonicalTag(value) {
    if (typeof value !== 'string' || value.length > 35 || !TAG.test(value)) return null;
    const [language, ...rest] = value.split('-');
    return [language.toLowerCase(), ...rest.map(part => part.length === 2 ? part.toUpperCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase())].join('-');
}
export const languageOf = tag => String(tag).split('-')[0].toLowerCase();
// `{name}` placeholders, filled from plain values. A placeholder without a value stays as written.
export const fill = (text, vars) => vars ? text.replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, name) => Object.hasOwn(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : whole) : text;
