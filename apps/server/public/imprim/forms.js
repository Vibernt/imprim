// Fire's form behaviour for the pages that need it: the one-time-code boxes, the list and name-and-value editors, the
// JSON code field and inline validation. Each control is an ordinary input or text area until this runs, so the form
// still works without it. It loads only Fire's forms module. Served as a static file; it makes no requests of its own.
//
// Fire restores a viewer's own theme and tweaks from localStorage when its core loads. Here the brand decides the look
// (the server renders it), so anything the Branding editor left behind is cleared first.
for (const key of ['fd-theme', 'fd-accent', 'fd-density', 'fd-tweaks', 'fd-tweaks-boot']) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}
const forms = await import('/fire/js/forms.js');
forms.init(document);
