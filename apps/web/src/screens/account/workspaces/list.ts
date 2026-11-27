import { html, nothing } from 'lit';
import { t } from '../../../lib/i18n';
import { href, type View } from '../../../lib/router';
import { loading, type LoadingPreset } from '../../loading';
import { pageHead } from '../../page-layout';
import { AccountScreen } from '../account-screen';
import { apiRoot, kindLabel, notFound, products, readWorkspace, roleLabel, tableStatus,
  workspacePath, workspaceTable, type Role, type Workspace } from './view';

interface WorkspaceList { workspaces: (Workspace & { role: Role })[] }

class ScreenAccountWorkspaces extends AccountScreen<WorkspaceList | { notFound: true }> {
  declare view: View;
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 3, cols: 5 } }];

  protected read() { return readWorkspace<WorkspaceList>(apiRoot); }

  protected override render() {
    if (this.data && 'notFound' in this.data) return notFound(this.view);
    const title = t('Workspaces'), kind = t('Kind'), role = t('Role'), apps = t('Products'), count = t('Members');
    const columns = [{ label: t('Name') }, { label: kind }, { label: role }, { label: count, numeric: true }, { label: apps }];
    const rows = this.data?.workspaces;
    const content = this.loadError ? tableStatus(columns.length, this.loadError, () => this.load(), t('The page did not load'))
      : rows?.length ? rows.map(workspace => html`<tr>
        <td data-stack-title><a class="fd-link" href=${href(workspacePath(workspace.workspace_id))}>${workspace.name}</a></td>
        <td data-label=${kind}>${kindLabel(workspace.kind)}</td><td data-label=${role}>${roleLabel(workspace.role)}</td>
        <td data-num data-label=${count}>${workspace.members}</td><td data-label=${apps}>${products(workspace.products)}</td></tr>`)
      : tableStatus(columns.length, t('Workspaces you join appear here.'), undefined, t('No workspaces yet'));
    const busy = !rows && !this.loadError;
    return html`<main class="fd-page" id="main" tabindex="-1"><div class="fd-frame">
      ${pageHead(title)}
      <section class="fd-band" data-pad=${busy ? 'sm' : 'none'} data-surface="surface" aria-label=${title} aria-busy=${busy}>
        ${busy ? loading(this.skeleton, { status: t('Loading workspaces'), late: t('Still loading. This is taking longer than usual.') })
          : workspaceTable(title, columns, content, nothing, true)}
      </section>
    </div></main>`;
  }
}
customElements.define('screen-account-workspaces', ScreenAccountWorkspaces);
