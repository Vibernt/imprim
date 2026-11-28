import 'fire-design/fire/components/tweaks.css';
import { html, type PropertyValues } from 'lit';
import { forms } from 'fire-design';
import { keyed } from 'lit/directives/keyed.js';
import { api } from '../../../lib/api';
import { icon } from '../../../lib/icon';
import { setting } from '../../page-layout';
import { AdminRealmScreen } from '../realm-screen';
import { failed, formData, notice } from '../realm-ui';
import { collect, copyFields, languageFields, nameFields } from './fields';
import { openLookPreview } from './look';
import { signatureFields } from './signature';
import { encodeFile, logoFields, releaseLogoPreviews } from './logos';
import type { Asset, BrandResponse, Branding, Look } from './types';
import { brandingTabs, specimen, type Section } from './view';
import type { LoadingPreset } from '../../loading';

class BrandingScreen extends AdminRealmScreen<BrandResponse> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'form', options: { count: 5 } }];
  static override properties = {
    assetDraft: { state: true }, lookPending: { state: true }, look: { state: true }, reset: { state: true }, previewCopy: { state: true },
  };
  private section: Section = 'look';
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
    this.assetDraft = {};
    this.look = {};
    this.reset = 0;
    this.previewCopy = {};
  }

  override disconnectedCallback() {
    this.previewLife?.abort();
    releaseLogoPreviews(this);
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

  private changeLogo = async (event: CustomEvent<{ value: File[] }>, slot: Asset) => {
    if (this.pending) return;
    const file = event.detail.value[0];
    if (!file) {
      this.removeLogo(slot);
      return;
    }
    const zone = event.currentTarget as HTMLElement;
    this.pending = true;
    try {
      const { id } = await api<{ id: string }>('/admin/api/branding/assets', { method: 'POST',
        body: { content_type: file.type, data: await encodeFile(file) } });
      if (!this.isConnected) return;
      forms.setFileProgress(zone, 100, { message: 'Uploaded' });
      this.assetDraft = { ...this.assetDraft, [slot]: id };
      notice('Logo uploaded', 'Save branding to use it.');
    } catch (error) {
      forms.setFileProgress(zone, 0, { state: 'error', message: 'Upload failed' });
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
    releaseLogoPreviews(this);
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
      // Seed the rows from the saved brand. Fire owns the preview until Save or Discard.
      logos: logoFields(branding, this.view.session.realm.display_name, this.pending, this.changeLogo),
      name: html`<div class="fd-stack" data-gap="4">${nameFields(branding)}</div>`,
      languages: languageFields(branding),
      words: html`<p class="fd-muted">Leave a field empty to use the built-in words in that language.</p>${copyFields(branding)}`,
    };
    return keyed(this.reset, html`<div class="fd-split">
      <div class="fd-split-main">
        <form class="fd-form" data-size="full" method="post" novalidate @submit=${this.save} @input=${this.updatePreview}>
          ${brandingTabs(this.section, panels, section => { this.section = section; }, this.pending)}
          <div class="fd-form-actions" data-variant="sticky">
            <button type="button" class="fd-btn" data-variant="ghost" ?disabled=${this.pending || this.lookPending}
              @click=${this.discard}>Discard changes</button>
            <button type="submit" class="fd-btn" data-variant="primary" ?disabled=${this.pending || this.lookPending}>Save branding</button>
          </div>
        </form>
      </div>
      <aside class="fd-panel" aria-label="Sign-in preview">
        <div class="fd-panel-body">${specimen({ ...this.assetDraft, ...this.previewCopy }, this.view.session.realm.display_name)}</div>
      </aside>
    </div>`);
  }
}

customElements.define('screen-branding', BrandingScreen);
