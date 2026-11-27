import { html } from 'lit';
import { icon } from '../../../lib/icon';
import { when } from '../core-view';
import { methodLabel, type Decision, type SignupRow } from './view';

export function signupCase(row: SignupRow, reason: string, decide: (action: Decision, reason: string) => void) {
  return html`<section data-case=${row.id} aria-labelledby="signup-case-title">
    <article class="fd-decision" aria-labelledby="signup-case-title">
      <header class="fd-decision-head">
        <span class="fd-tile" data-tone="warning">${icon('users')}</span>
        <div class="fd-decision-heading">
          <h2 class="fd-decision-title im-breakable" id="signup-case-title" tabindex="-1">Create ${row.workspace_name}?</h2>
        </div>
        <span class="fd-status" data-variant="pill" data-size="sm" data-tone="warning">Pending</span>
      </header>
      <dl class="fd-decision-parts">
        <div class="fd-decision-part">
          <dt class="fd-decision-label">The change</dt>
          <dd class="fd-decision-lead im-breakable">Create the team workspace ${row.workspace_name} with ${row.app_name || row.product}</dd>
        </div>
        <div class="fd-decision-part">
          <dt class="fd-decision-label">Who it touches</dt>
          <dd class="fd-decision-lead im-breakable">${row.email}</dd>
          <dd class="fd-decision-detail">Becomes the workspace owner.</dd>
        </div>
        <div class="fd-decision-part">
          <dt class="fd-decision-label">Evidence</dt>
          <dd><ul class="fd-decision-facts">
            <li><span>Email verified</span><b>Yes</b></li>
            <li><span>Sign-up method</span><b>${methodLabel(row)}</b></li>
            <li><span>Requested</span><b>${when(row.created)}</b></li>
          </ul></dd>
        </div>
        <div class="fd-decision-part">
          <dt class="fd-decision-label">Who signs</dt>
          <dd class="fd-decision-lead">A realm administrator</dd>
        </div>
      </dl>
    </article>
    <form class="fd-commit" aria-label="Decide the sign-up request" @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      event.stopPropagation(); // The shared held-action helper owns this submission.
      const action = (event.submitter as HTMLButtonElement | null)?.value;
      if (action === 'approve' || action === 'decline') {
        decide(action, String(new FormData(event.currentTarget as HTMLFormElement).get('reason') ?? ''));
      }
    }}>
      <div class="fd-field">
        <label class="fd-field-label" for="signup-decline-reason">Reason for declining (optional)</label>
        <textarea class="fd-textarea" id="signup-decline-reason" name="reason" rows="3" maxlength="500"
          aria-describedby="signup-reason-hint" .value=${reason}></textarea>
        <p class="fd-field-hint" id="signup-reason-hint">Administrators can see this reason.</p>
      </div>
      <div class="fd-commit-actions">
        <button class="fd-btn" type="submit" data-variant="primary" value="approve">${icon('check')}<span>Create workspace</span></button>
        <button class="fd-btn" type="submit" data-variant="outline" value="decline">Decline</button>
      </div>
    </form>
  </section>`;
}
