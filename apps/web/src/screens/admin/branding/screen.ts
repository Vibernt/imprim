import 'fire-design/fire/components/tweaks.css';
import { html, type PropertyValues } from 'lit';
import { forms } from 'fire-design';
import { keyed } from 'lit/directives/keyed.js';
import { api } from '../../../lib/api';
import { icon } from '../../../lib/icon';
import { card, setting } from '../../page-layout';
import { AdminRealmScreen } from '../realm-screen';
import { failed, formData, notice } from '../realm-ui';
import { collect, copyFields, languageFields, nameFields } from './fields';
import { openLookPreview } from './look';
import { signatureFields } from './signature';
import { encodeFile, logoFields } from './logos';
import type { Asset, BrandResponse, Branding, Look } from './types';
import { sections, specimen, type Section } from './view';

class BrandingScreen extends AdminRealmScreen<BrandResponse> {
  static override properties = {
    section: { state: true }, assetDraft: { state: true }, lookPending: { state: true }, look: { state: true }, reset: { state: true }, previewCopy: { state: true },
  };
  declare private section: Section;
  declare private assetDraft: Branding;
  declare private lookPending: boolean;
  declare private reset: number;
  declare private look: Look;
  declare private previewCopy: Pick<Branding, 'name' | 'copy'>;
  private previewLife?: AbortController;
  private tweaks?: Awaited<ReturnType<typeof openLookPreview>>;
  protected heading = 'Branding';
  protected override get description() { return 'How sign-in, consent and account pages look for this realm. Apps can override it.'; }
  protected endpoint() { return '/admin/api/branding'; }

  constructor() {
    super();
    this.section = 'look';
    this.assetDraft = {};
    this.look = {};
    this.reset = 0;
    this.previewCopy = {};
  }

  override disconnectedCallback() {
    this.previewLife?.abort();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    if (changed.has('data') && this.data) {
      this.assetDraft = this.data.branding;
      this.previewCopy = { name: this.data.branding.name, copy: this.data.branding.copy };
      this.look = this.data.branding.look ?? {};
      const address = new URL(location.href);
      if (address.searchParams.get('saved') === '1') {
        address.searchParams.delete('saved');
        history.replaceState(history.state, '', address);
        notice('Branding saved', 'Sign-in pages use it within 5 minutes.');
      }
    }
  }

  private editLook = async (edit: (tweaks: NonNullable<BrandingScreen['tweaks']>) => void) => {
    if (!this.data || this.lookPending) return;
    this.lookPending = true;
    try {
      if (!this.tweaks) {
        this.previewLife = new AbortController();
        this.tweaks = await openLookPreview(this.look, look => { this.look = look; }, this.previewLife.signal);
      }
      if (this.tweaks) edit(this.tweaks);
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.lookPending = false;
    }
  };

  private openTweaks = (event: MouseEvent) => {
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    void this.editLook(tweaks => tweaks.toggle(trigger));
  };

  private upload = async (event: CustomEvent<{ value: File[] }>, slot: Asset) => {
    const file = event.detail.value[0];
    if (this.pending || !file) return;
    const zone = event.currentTarget as HTMLElement;
    const row = zone.nextElementSibling?.querySelector<HTMLElement>('.fd-file[data-state="uploading"]');
    this.pending = true;
    try {
      if (row) forms.setFileProgress(row, 0);
      const { id } = await api<{ id: string }>('/admin/api/branding/assets', { method: 'POST',
        body: { content_type: file.type, data: await encodeFile(file) } });
      if (!this.isConnected) return;
      if (row) forms.setFileProgress(row, 100, { message: 'Uploaded' });
      this.assetDraft = { ...this.assetDraft, [slot]: id };
      notice('Logo uploaded', 'Save branding to use it.');
    } catch (error) {
      if (row) forms.setFileProgress(row, 0, { state: 'error', message: 'Upload failed' });
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  private removeLogo = (slot: Asset) => {
    const draft = { ...this.assetDraft };
    delete draft[slot];
    this.assetDraft = draft;
  };

  private discard = () => {
    if (!this.data) return;
    this.previewLife?.abort();
    this.tweaks = undefined;
    this.assetDraft = this.data.branding;
    this.previewCopy = { name: this.data.branding.name, copy: this.data.branding.copy };
    this.look = this.data.branding.look ?? {};
    this.reset++;
  };

  private updatePreview = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || (target.name !== 'name' && !target.name.startsWith('copy.'))) return;
    const { name, copy } = collect(new FormData(target.form!), this.assetDraft, this.look);
    this.previewCopy = { name, copy };
  };

  private save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (this.pending || this.lookPending || !this.data) return;
    const branding = collect(formData(event), this.assetDraft, this.look);
    this.pending = true;
    try {
      await api(this.endpoint(), { method: 'POST', body: { branding, version: this.data.version } });
      if (this.isConnected) location.replace('/admin/branding?saved=1');
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  protected content({ branding }: BrandResponse) {
    const panels = {
      look: html`<div class="fd-stack" data-gap="3">
        ${setting('Appearance', 'Preview the palette, type set and dials before saving.', html`<button class="fd-btn" data-variant="outline" type="button" data-fd-tweaks-open aria-expanded="false"
          ?disabled=${this.lookPending || this.pending} @click=${this.openTweaks}>${icon('sliders-horizontal')}<span>Open tweaks</span></button>`)}
        ${signatureFields(this.look, this.lookPending || this.pending, signature => void this.editLook(tweaks => tweaks.set({ signature })))}
      </div>`,
      logos: logoFields(this.assetDraft, this.pending, this.upload, this.removeLogo),
      name: html`<div class="fd-stack" data-gap="4">${nameFields(branding)}</div>`,
      languages: languageFields(branding),
      words: html`<p class="fd-muted">Leave a field empty to use the built-in words in that language.</p>${copyFields(branding)}`,
    };
    return keyed(this.reset, html`<div class="fd-stack" data-gap="6">
      <nav class="fd-row" data-wrap data-gap="2" aria-label="Branding">
        ${sections.map(([id, label, glyph]) => html`<button class="fd-btn" data-variant=${this.section === id ? 'outline' : 'ghost'} type="button"
          aria-pressed=${this.section === id} @click=${() => { this.section = id; }}>${icon(glyph)}<span>${label}</span></button>`)}
      </nav>
      <form class="fd-form" data-size="full" method="post" novalidate @submit=${this.save} @input=${this.updatePreview}>
        <div class="fd-grid" data-cols="2" data-gap="6">
          <fieldset class="fd-stack" data-gap="4" ?disabled=${this.pending}>
            <legend class="fd-sr-only">Branding</legend>
            ${sections.map(([id, label]) => html`<div ?hidden=${this.section !== id}>${card(label, panels[id])}</div>`)}
          </fieldset>
          <div>${specimen({ ...this.assetDraft, ...this.previewCopy }, this.view.session.realm.display_name)}</div>
        </div>
        <div class="fd-form-actions" data-variant="sticky">
          <button type="button" class="fd-btn" data-variant="ghost" ?disabled=${this.pending || this.lookPending}
            @click=${this.discard}>Discard changes</button>
          <button type="submit" class="fd-btn" data-variant="primary" ?disabled=${this.pending || this.lookPending}>Save branding</button>
        </div>
      </form>
    </div>`);
  }
}

customElements.define('screen-branding', BrandingScreen);
