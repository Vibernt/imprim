// Turns a 6-digit code field into Fire's one-time-code boxes: typing advances, Backspace steps back, a pasted code fills
// every box. The field is an ordinary input until this runs, so the form still works without it. It loads only Fire's
// forms module. Served as a static file; it makes no requests of its own.
//
// Fire restores a viewer's own theme and tweaks from localStorage when its core loads. Here the brand decides the look
// (the server renders it), so anything the Branding editor left behind is cleared first.
for (const key of ['fd-theme', 'fd-accent', 'fd-density', 'fd-tweaks', 'fd-tweaks-boot']) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}
const forms = await import('/fire/js/forms.js');
forms.init(document);
