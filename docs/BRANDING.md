# Branding

Each realm has default branding, and each app can override it. Branding is **tokens only**: a name, colours, a
corner radius, a font from a fixed list, short copy, links and uploaded logo assets. There is no custom CSS, HTML
or JavaScript, so a brand can never weaken the Content Security Policy or put script on a page that handles
credentials.

Branding shows on the sign-in page, consent pages, the account page, signed-out and error pages, and in the
footer of every email.

## Fields

| Field | Value |
|---|---|
| `name` | Shown in the header, page titles, email subjects and text. Up to 200 characters, escaped. |
| `legal_name` | Footer `© <legal_name>` on pages and emails. |
| `support_url`, `privacy_url`, `terms_url` | `https://` links in the footer. |
| `support_email` | Footer "Help" link (when there is no `support_url`) and the email footer. |
| `locale` | The page language tag, such as `en` or `en-GB` (`<html lang>`). |
| `logo_light`, `logo_dark`, `mark` | Uploaded asset ids. The logo replaces the name in the header; `logo_dark` is used in dark mode; `mark` is the favicon and sits beside the name when there is no logo. |
| `theme` | `primary`, `primary_text`, `background`, `surface`, `text`, `muted`, `border`, `danger` (security warnings) as `#rrggbb`; `radius` 0–24 (pixels); `font` one of `system`, `humanist`, `geometric`, `serif`, `mono` (system font stacks, nothing is downloaded). |
| `theme_dark` | The same colours for dark mode. Radius and font come from `theme`. |
| `copy` | Plain text, up to 300 characters each: `sign_in_heading`, `sign_in_help`, `consent_intro`, `signed_out`, `footer`. |

Unknown fields, unknown tokens, colour names, `http:` or `javascript:` links, control characters and bidirectional
override characters are refused.

**Contrast.** Every save is checked against WCAG AA (4.5:1) on the merged theme, in light and in dark: text on
background, text on surface, muted on surface and on background (the footer), button text on primary, primary on
surface (links and outline buttons), and danger on surface (warnings). An app override is checked against its
realm's defaults, so an app cannot save a theme that fails once merged. A realm change that would make any app's
merged theme fail is refused, and the error names those apps. An empty app value, such as `"name": ""`, keeps the
realm's.

```json
{
  "name": "Acme",
  "legal_name": "Acme Ltd",
  "privacy_url": "https://acme.example/privacy",
  "terms_url": "https://acme.example/terms",
  "support_email": "help@acme.example",
  "logo_light": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "theme": { "primary": "#0b5d1e", "radius": 6, "font": "humanist" },
  "theme_dark": { "primary": "#7fd18f", "primary_text": "#0a1f0e" },
  "copy": { "sign_in_heading": "Welcome back to Acme", "footer": "Acme accounts are run on Imprim." }
}
```

## Where it is set

- **Realm defaults:** the admin console's Branding page (`/admin/branding`), or `branding` in the realm config
  ([Realms](REALMS.md)). The page has a live preview of any app's sign-in page.
- **An app's overrides:** the app's `branding` field, in the admin console or the seed script
  ([Clients](CLIENTS.md)). Theme and copy merge key by key over the realm's; other fields replace.

Saving branding needs an admin session with a recent sign-in and second factor, the same CSRF and Origin checks
as every admin write, and the current `version`, so two admins cannot overwrite each other silently.

## Assets

Upload a logo or mark in the console, or with `POST /admin/api/branding/assets` and
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

## Theme stylesheet

Pages link `/assets/theme.css` (realm) or `/assets/theme.css?client=<id>` (an app in that realm). It sets CSS
variables only, with a `prefers-color-scheme: dark` block, and is cached for five minutes. The page stylesheet
uses only those variables.

## Emails

Sign-in links and security notices are plain text. Their subject and greeting use the app's or realm's `name`,
and they end with the support contact and `© legal_name` when set.
