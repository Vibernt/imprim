# Languages and translating

Imprim's people-facing pages and emails come in English, Spanish (`es`), French (`fr`), German (`de`) and
Portuguese, Brazil (`pt-BR`). The admin console is English. The Spanish, French, German and Portuguese catalogues were
drafted with AI assistance and **await review by native speakers** before production use. Corrections are welcome as
pull requests.

## What is translated

- Every page a person sees: sign-in, check email, signed in and out, errors, second factor, set password, agent
  consent, device code, logout, and the account pages (Profile, Security, Sessions and apps, Agents, two-factor).
- The errors those pages and their scripts show: HTML error pages, and the `error_description` of the browser
  endpoints (`/v1/auth/*`, `/account/*`, `/mfa`, `/agent/consent`, `/device`, `/logout`, `/login`). The scripts
  `/assets/sign-in.js` and `/assets/passkey.js` are served per language as `?lang=<tag>`.
- Every email: subject, text part and HTML part ([Branding](BRANDING.md#emails)).

Not translated:

- **Protocol errors.** The `error_description` of `/authorize` error redirects, `/token`, `/register`,
  `/device_authorization`, `/introspect`, `/revoke`, `/userinfo`, `/v1/invitations`, `/v1/grants` and the admin API
  stays English. RFC 6749 limits it to ASCII, and it is written for developers.
- **Logs and audit records.**
- **Data.** Names of apps, agents, scopes, devices and brands are shown as they were given. A device description
  ("Chrome on macOS") is translated where it is shown.
- **A few labels inside Fire's own scripts** (password show or hide, sidebar collapse, the phone menu). Fire is
  vendored and not edited; see [Fire requests](fire/REQUESTS.md).

## How a language is chosen

For each request, Imprim takes the first of these that the brand offers:

1. The app's `ui_locales` on the authorization request (space-separated BCP 47 tags, as OIDC Core 3.1.2.1). Malformed
   or unknown tags are dropped, never refused or shown back. Up to 10 are kept, with the request.
2. The person's saved language: **Account → Profile → Language**. *Automatic*, the default, saves nothing.
3. The browser's `Accept-Language`. Only its first 1 KiB and 20 entries are read.
4. The app's `branding.locale`, then the realm's.
5. English, or the first language the brand offers if English is not one of them.

A tag matches its own language (`de-AT` reads German, `pt-PT` reads Brazilian Portuguese). A brand's `locales`
limits the languages it offers ([Branding](BRANDING.md#languages)); discovery lists them as
`ui_locales_supported`. `<html lang>` names the language, or the brand's own regional tag when it is the same
language (a realm on `en-GB` keeps `en-GB`).

Emails follow the request's language: sign-in and email-change links, and notices of the person's own actions. A
two-factor reset by an administrator goes in the person's saved language, else the realm's.

## How it works

The English text in the code is each message's id. `apps/server/src/i18n/<tag>.mjs` maps ids to translations:

```js
export default Object.freeze({
    "Sign in to {name}": "Bei {name} anmelden",
    "{count} passkeys": { one: "{count} Passkey", other: "{count} Passkeys" },
    "Administrators can <0>sign in here</0>.": "Administratoren können sich <0>hier anmelden</0>."
});
```

- `t(env, 'Sign in to {name}', { name })` returns plain text; the page helpers escape it.
- `tHtml(env, id, vars, tags)` escapes the translation, then replaces numbered tags such as `<0>…</0>` with markup
  from the code. A translation can move a tag but never add markup.
- `tPlural(env, count, one, other)` picks a form with `Intl.PluralRules`; the catalogue gives every form the
  language uses.
- Errors keep their English message as the id (`invariant(ok, 'code', 'Use {min} to {max} characters.', 400, { min, max })`)
  and are translated where they are turned into a page or a browser response.
- `msg('…')` marks an id where no request is at hand (a table of labels, a page script, an email definition).
- Dates in English keep Imprim's formats; other languages use `Intl.DateTimeFormat` in UTC.

A missing translation shows the English text, so a page never breaks. The check catches it before release.

## Adding or fixing a language

1. List what is missing:

   ```bash
   node scripts/i18n.mjs missing de
   ```

   Each entry has the id and where it is used (`file:line`), so you can see whether it is a button, a heading, an
   error or an email subject.
2. Edit `apps/server/src/i18n/<tag>.mjs`. Keep every `{placeholder}` and numbered tag, add no other markup, and give
   plural entries every form the language uses. A new language is also added to `LANGUAGES` and `LANGUAGE_NAMES` in
   `apps/server/src/i18n/languages.mjs` and to `catalogues` in `apps/server/src/i18n/index.mjs`.
3. Follow [Fire's writing rules](fire/WRITING.md): sentence case, short buttons, no exclamation marks. Security wording
   (the agent consent warning, "If this was not you", expiry times) must stay exact.
4. Run the checks:

   ```bash
   npm run check
   ```

   ```bash
   npm run test:quiet
   ```

   `npm run check` fails on a missing or orphaned entry, a changed placeholder or tag, added markup, wrong plural forms,
   or a message id written as a template literal. `tests/i18n-coverage.test.mjs` renders the pages and emails in a
   test-only language that brackets every message, and fails on any visible word that skipped the catalogue.
5. Look at the emails: `node scripts/email-preview.mjs` writes every kind in every language to `email-preview/`.

Changing English text changes its id: update every catalogue in the same change (the check lists them).
