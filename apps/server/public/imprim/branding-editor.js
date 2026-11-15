// The admin Branding page: Fire's Tweaks panel edits the realm's look live on this page; logos upload to the realm's
// asset store; Save sends the whole branding with the version it was loaded at (a stale version is refused).
// Served as a static file. Same-origin requests only; the CSRF value comes from the page.
import { init, tweaks, overlays } from '/fire/fire.js';

const root = document.getElementById('branding-editor');
const csrf = root.dataset.csrf;
let version = Number(root.dataset.version);
const saved = JSON.parse(root.dataset.branding || '{}');
let branding = structuredClone(saved);
const summary = document.getElementById('look-summary');
const errorBox = document.getElementById('branding-error');
const errorText = document.getElementById('branding-error-text');

// The saved look's stylesheet would sit under the panel's live values (a value moved back to its default would still
// show the saved one), so the editor previews from the panel alone.
document.querySelector('link[rel=stylesheet][href^="/assets/theme.css"]')?.remove();

// Tweaks keeps a viewer's own look in localStorage. Here the realm's saved look wins: start from the default, note it,
// then apply the saved look, so only real differences are saved.
const defaults = tweaks.reset();
const differences = (state) => {
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === 'tone') {
      const tone = Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== defaults.tone[k]));
      if (Object.keys(tone).length) out.tone = tone;
    } else if (value !== defaults[key]) out[key] = value;
  }
  return out;
};
tweaks.set(saved.look || {});
const showLook = () => { summary.textContent = JSON.stringify(differences(tweaks.get())); };
showLook();
document.documentElement.addEventListener('fd:change', (event) => { if (event.detail?.name === 'tweaks') showLook(); });

const api = async (path, body) => {
  const response = await fetch(`/admin/api/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_description || `The server answered ${response.status}.`);
  return result;
};
const fail = (message) => { errorText.textContent = message; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'nearest' }); };

// Logos: read the file, send it as base64, keep the returned asset id.
const preview = (slot, url) => {
  const tile = root.querySelector(`[data-slot-preview="${slot}"]`);
  tile.replaceChildren();
  if (url) { const img = new Image(); img.className = 'x-logo'; img.alt = ''; img.src = url; tile.append(img); }
  root.querySelector(`[data-remove="${slot}"]`).hidden = !url;
};
root.addEventListener('change', async (event) => {
  const input = event.target.closest('input[type=file][data-slot]');
  if (!input?.files?.[0]) return;
  const file = input.files[0];
  errorBox.hidden = true;
  if (file.size > 262144) { fail(`${file.name} is ${Math.ceil(file.size / 1024)} KiB. Logos are up to 256 KiB.`); input.value = ''; return; }
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
      reader.readAsDataURL(file);
    });
    const { id, url } = await api('branding/assets', { content_type: file.type, data });
    branding[input.dataset.slot] = id;
    preview(input.dataset.slot, url);
    overlays.toast({ title: 'Logo uploaded', description: 'Save branding to use it.' });
  } catch (error) { fail(error.message); }
  input.value = '';
});
root.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove]');
  if (!remove) return;
  delete branding[remove.dataset.remove];
  preview(remove.dataset.remove, null);
});

// Fields: name, links and copy. An empty field removes the value, so the default shows.
const collect = () => {
  const next = { ...branding };
  delete next.copy;
  const copy = {};
  for (const input of root.querySelectorAll('input[name]:not([type=file]):not([type=hidden])')) {
    const value = input.value.trim();
    if (input.name.startsWith('copy.')) { if (value) copy[input.name.slice(5)] = value; }
    else if (value) next[input.name] = value; else delete next[input.name];
  }
  if (Object.keys(copy).length) next.copy = copy;
  const look = differences(tweaks.get());
  if (Object.keys(look).length) next.look = look; else delete next.look;
  return next;
};

document.getElementById('branding-save').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  errorBox.hidden = true;
  button.setAttribute('aria-busy', 'true'); button.disabled = true;
  try {
    const result = await api('branding', { branding: collect(), version });
    version = result.version;
    branding = structuredClone(result.branding);
    overlays.toast({ title: 'Branding saved', description: 'Sign-in pages use it within 5 minutes.', tone: 'success' });
  } catch (error) { fail(error.message); }
  finally { button.removeAttribute('aria-busy'); button.disabled = false; }
});
document.getElementById('branding-reset').addEventListener('click', () => location.reload());
init(root);
