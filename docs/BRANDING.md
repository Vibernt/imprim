# Branding

Each realm has default branding, and each app can override it. Every page is built with the
[Fire design system](fire/README.md), and a brand changes how Fire looks, never what it is made of: a **look**
(Fire's palette, tone, type set and other tweaks), a name, short copy, links and uploaded logos. There is no custom
CSS, HTML or JavaScript, so a brand can never weaken the Content Security Policy or put script on a page that
handles credentials.

Branding shows on the sign-in page, second-factor, consent and device pages, the account page, signed-out and
error pages, the admin console, and in the footer of every email.

## Edit it in the console

Open **Branding** in the admin console (`/admin/branding`).

- **Look:** *Open tweaks* opens Fire's Tweaks panel. Pick a palette, bend its tone, choose a type set, density,
  corners, lines, text size, contrast, motion and texture, or force light or dark. The console itself changes as you
  go, and a sample sign-in card shows the result. Nothing reaches people until you choose *Save branding*.
- **Logo:** upload a logo, an optional dark-mode logo and a square mark (the browser-tab icon). Until a logo is
  uploaded, pages show the **IMPRIM dot-matrix logo** beside the realm's name.
- **Name and links**, and **Words** (sign-in heading and line, agent consent line, signed-out line, footer line).
  An empty field uses the default.
- *Open the sign-in page* previews it with your apps' sign-in methods.

Saving needs an admin session with a recent sign-in and second factor, the same CSRF and Origin checks as every
admin write, and the version the page loaded, so two admins cannot overwrite each other silently.

## Fields

| Field | Value |
|---|---|
| `look` | Fire tweak state; see below. Merged key by key over the realm's (and `tone` per key). |
| `name` | Shown in the header, page titles, email subjects and text. Up to 200 characters, escaped. |
| `legal_name` | Footer `© <legal_name>` on pages and emails. |
| `support_url`, `privacy_url`, `terms_url` | `https://` links in the footer. |
| `support_email` | Footer "Help" link (when there is no `support_url`) and the email footer. |
| `locale` | The page language tag, such as `en` or `en-GB` (`<html lang>`). |
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
example `{"name": "My app", "look": {"palette": "iris"}}`.

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

Sign-in links and security notices are plain text. Their subject and greeting use the app's or realm's `name`,
and they end with the support contact and `© legal_name` when set.
