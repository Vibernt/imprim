// The app shell's behaviour on the console and account pages: sidebar collapse, the phone menu and the hero texture.
// It loads only Fire's icon, shell and texture modules. Served as a static file; it makes no requests of its own.
//
// Fire keeps a viewer's own theme and tweaks in localStorage and restores them when its core loads. Here the brand
// decides the look (the server renders it), so anything the Branding editor left behind is cleared first.
for (const key of ['fd-theme', 'fd-accent', 'fd-density', 'fd-tweaks', 'fd-tweaks-boot']) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}
const [icons, shell, texture] = await Promise.all([import('/fire/js/icons.js'), import('/fire/js/shell.js'), import('/fire/js/texture.js')]);
icons.initIcons();   // the sprite the phone menu's close icon draws from
shell.init(document);
texture.init(document);
