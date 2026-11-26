# Branding

Each realm has default branding, and each app can override it. Every page is built with the
[Fire design system](fire/README.md), and a brand changes how Fire looks, never what it is made of: a **look**
(Fire's palette, tone, type set and other tweaks), a name, short copy, links and uploaded logos. There is no custom
CSS, HTML or JavaScript, so a brand can never weaken the Content Security Policy or put script on a page that
handles credentials.

Branding shows on the sign-in page, second-factor, consent and device pages, the account pages, signed-out and
error pages, the admin console, and in the footer of every email. Sign-in and consent screens put the brand centred
above one card; the console and the account pages show it at the top of the sidebar. Every page ends with a small
"Powered by Imprim" line.

## Edit it in the console

Open **Branding** in the admin console (`/admin/branding`).

- **Look:** *Open tweaks* opens Fire's Tweaks panel. Choose a preset look or adjust the palette, type, structure
  and signature. Set light or dark mode, or follow the system. The console itself changes as you
  go, and a sample sign-in card shows the result. Nothing reaches people until you choose *Save branding*.
- **Logo:** upload a logo, an optional dark-mode logo and a square mark. The logo leads sign-in and consent
  screens. The mark is the browser-tab icon, sits beside the name when there is no logo, and leads the console and
  account sidebar. Until a mark is uploaded, pages draw the **first letter of the name in a dot matrix**.
- **Name and links**, **Languages** (the default language and the languages offered) and **Words** (sign-in heading
  and line, agent consent line, signed-out line, footer line), in the default language and, under each language, in
  that language. An empty field uses the built-in words, translated.
- *Open saved sign-in page* previews it with your apps' sign-in methods. *Open sample email* shows the saved
  branding in the sign-in email, with no email sent.

Saving needs an admin session with a recent sign-in and second factor, the same CSRF and Origin checks as every
admin write, and the version the page loaded, so two admins cannot overwrite each other silently.

## Fields

| Field | Value |
|---|---|
| `look` | Fire tweak state. App settings override the realm's. The `tone` and `signature` objects also merge per key. |
| `name` | Shown beside the mark, in page titles, email subjects and text. Up to 200 characters, escaped. |
| `summary` | Apps only. One to 80 characters of plain text for the app list. |
| `legal_name` | Footer `© <legal_name>` on pages and emails. |
| `support_url`, `privacy_url`, `terms_url` | `https://` links in the footer. |
| `support_email` | Footer "Help" link (when there is no `support_url`) and the email footer. |
| `locale` | The default language, such as `de` or `en-GB`: used when the browser asks for none the brand offers, and as `<html lang>` for that language. |
| `locales` | The languages offered, from `en`, `es`, `fr`, `de`, `pt-BR`. Default: all of them. `locale` must be one of them. |
| `locale_copy` | The brand's words per language: `{ "de": { "sign_in_heading": "…" } }`, same keys and limits as `copy`. An app can also set `locale_copy.<tag>.summary` with the same limit as `summary`. |
| `logo_light`, `logo_dark`, `mark` | Uploaded asset ids. |
| `copy` | Plain text, up to 300 characters each: `sign_in_heading`, `sign_in_help`, `consent_intro`, `signed_out`, `footer`. |

**The look.** Every key is optional; anything left out is Fire's default.

| Key | Values |
|---|---|
| `palette` | `ember` (default), `volt`, `iris`, `ocean`, `forest`, `graphite`, `rose`, `honey`, `plum`, `lagoon`, `paper`, `clay`, `mint`, `glacier`, `midnight` |
| `tone` | `{ hue: −180…180, vivid: 0…150, light: −12…12, warmth: −100…100 }`, whole numbers |
| `type` | `geist` (default), `grotesk`, `editorial`, `book`, `atelier`, `poster`, `terminal`, `pixel`, `matrix`, `cyber`, `loud`, `gallery` |
| `theme` | `system` (default), `light`, `dark` |
| `density` | `compact`, `comfortable` (default), `spacious` |
| `corners` | 0 to 2 in steps of 0.125 (default 1) |
| `lines` | 1 (default), 1.5, 2 |
| `textSize` | `sm`, `md` (default), `lg` |
| `contrast` | `default`, `high` |
| `motion` | `off`, `default`, `slow` |
| `texture` | 0 to 1.5 in steps of 0.05 (default 1) |
| `surfaces` | `objects` (default), `flat`, `outlined` |
| `elevation` | `soft` (default), `none`, `lifted` |
| `controls` | `soft` (default), `outlined`, `filled` |
| `headings` | `sentence` (default), `upper`, `mono` |
| `imagery` | `natural` (default), `mono`, `duotone`, `wash` |
| `signature` | Texture and frame marks. Fire defines the available `field`, `mark`, `ramp` and `marks` choices in `fire/js/theme.js`. `cell` is `auto` or an integer from 4 to 24. `intensity` goes from 0.4 to 1.6 in steps of 0.05 (default 1). |

Values outside these are refused, not clamped. **Contrast** is Fire's job: its palette engine keeps accent text at
4.5:1 or more on the page and on surfaces, and button labels readable, for every palette and after any tone.

```json
{
  "name": "Acme",
  "legal_name": "Acme Ltd",
  "privacy_url": "https://acme.example/privacy",
  "terms_url": "https://acme.example/terms",
  "support_email": "help@acme.example",
  "logo_light": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "look": { "palette": "forest", "tone": { "warmth": 30 }, "type": "editorial", "corners": 0.75 },
  "copy": { "sign_in_heading": "Welcome back to Acme", "footer": "Acme accounts run on Imprim." }
}
```

An app sets its own `branding` in the console's client editor or the seed script ([Clients](CLIENTS.md)), for
example `{"name": "Notes", "summary": "Shared notes for teams", "look": {"palette": "iris"}}`.

## Languages

Pages and emails come in English, Spanish, French, German and Portuguese (Brazil) ([Languages](TRANSLATING.md)). A
brand chooses which it offers (`locales`) and which to fall back to (`locale`); an app's values replace the realm's.
`copy` is in the brand's default language; `locale_copy` holds the same words in other languages. On a page in
language L, a copy key shows `locale_copy[L]`, then `copy` if L is the default language, then Imprim's built-in text
in L. `locale_copy` merges per language and per key, app over realm. App lists use the page language for each
app's summary. They use `summary` in the app's default language, and omit the description when that language has
no text.

```json
{ "locale": "de", "locales": ["de", "en"], "copy": { "sign_in_heading": "Willkommen bei Acme" },
  "locale_copy": { "en": { "sign_in_heading": "Welcome to Acme" } } }
```

## How it is applied

The server renders the look the way Fire's Tweaks panel applies it in the browser: `data-palette`, `data-type`,
`data-theme`, `data-density`, `data-text-size` and `data-contrast` on `<html>`, and the toned palette and scales as
custom properties in `/assets/theme.css` (or `/assets/theme.css?client=<id>` for an app), cached for five minutes.
It uses Fire's own palette engine, so what an admin sees in the panel is what people see.

## Assets

Upload in the console, or with `POST /admin/api/branding/assets` and
`{"content_type": "image/svg+xml", "data": "<base64>"}`. The answer is `{"id", "url"}`; put the `id` in a
`logo_*` or `mark` field.

- SVG, PNG, JPEG or WebP, at most 256 KiB. The bytes must match the declared type.
- SVGs are checked against an allowlist and refused, not cleaned, if anything falls outside it. Allowed elements:
  `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `defs`, `linearGradient`,
  `radialGradient`, `stop`, `title`, `desc`, `clipPath` and `mask`, with presentation attributes only. No prefixed
  names, `style`, `href`, processing instructions other than a UTF-8 XML declaration, doctype, CDATA or entities
  other than `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`; `url(…)` only as `url(#id)`. Export logos as plain paths
  and shapes.
- Assets are stored in D1, content-addressed by SHA-256 and scoped to the realm. They are served from
  `/assets/brand/<id>` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`,
  `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`, and cached as immutable.

## Emails

Every email has a plain-text part and a branded HTML part, in the recipient's language
([Languages](TRANSLATING.md#how-a-language-is-chosen)). Sign-in and set-password links wear the app's brand; the
email-change link and security notices wear the realm's.

- **Text.** In English it is exactly what Imprim has always sent: the message, the link on its own line, and, under
  `--`, the footer words, `Help:` and `© legal_name`.
- **HTML.** One fixed layout in Fire's look: the brand at the top, a card with a heading, the message and a button
  (the link is repeated below it as text), then the footer with Privacy and Terms links and "Powered by Imprim".
  The colours come from the brand's look through Fire's palette engine, as on pages, in light and dark: clients that
  support `prefers-color-scheme` switch, the rest keep the light version. A forced `theme` gives one scheme. The
  type set names the font, with system fallbacks; no web font is loaded.
- **Logo.** A PNG or JPEG `logo_light` travels inside the email as an inline (`cid:`) image, with `logo_dark` swapped
  in dark mode where the client allows. Emails load no remote image, so nothing reports an open. An SVG or WebP logo,
  which Gmail and Outlook do not show, or no logo, gives the brand's initial in dots, drawn with table cells, and the
  name. Upload a PNG to have the logo in emails.
- **Safety.** Every value is escaped, including an agent's self-chosen name. Links are the issuer's own URLs and the
  brand's validated `https` links. Subjects are one line.

`node scripts/email-preview.mjs [out-dir] [branding.json]` writes every email in every language as HTML and text, to
check a brand before saving it.
