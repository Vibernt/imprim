import { data } from 'fire-design';
import type { LitElement } from 'lit';
import { ApiError } from '../lib/api';
import { confirmRow, confirmRowId, matchesPhrase, phraseInput, type ConfirmRowCopy } from './confirm-row';

type Confirmation<Result> = ConfirmRowCopy & {
  request: () => Promise<Result>;
  done: (result: Result) => void | Promise<void>;
  opened?: () => void;
};

export class RowConfirmations {
  private active?: HTMLElement;
  private running?: HTMLElement;

  constructor(private readonly host: LitElement, private readonly genericError: () => string) {}

  get pending() { return Boolean(this.running); }

  clear() {
    if (this.active) data.closeConfirmRow(this.active, { focus: false });
  }

  view<Result>(options: Confirmation<Result>) {
    return confirmRow(options, this.running?.id === confirmRowId(options.id), row => {
      if (this.active !== row) this.clear();
      this.active = row;
      options.opened?.();
    }, row => {
      if (row === this.active) this.active = undefined;
    }, (event, row) => {
      if (this.running || row !== this.active ||
          (options.phrase && !matchesPhrase(phraseInput(row)!, options.phrase))) return;
      event.preventDefault();
      void this.run(row, options);
    });
  }

  private async run<Result>(row: HTMLElement, options: Confirmation<Result>) {
    this.running = row;
    this.host.requestUpdate();
    let result: Result;
    try {
      result = await Promise.resolve().then(options.request);
    } catch (error) {
      if (row === this.active && row.isConnected) {
        data.failConfirmRow(row, error instanceof ApiError ? error.description : this.genericError());
      }
      return;
    } finally {
      this.running = undefined;
      this.host.requestUpdate();
    }

    // Let Lit re-enable the other row menus before Fire moves focus. Refresh the records only after that.
    await this.host.updateComplete;
    if (row !== this.active || !row.isConnected) return;
    data.closeConfirmRow(row, { focus: 'next' });
    await options.done(result);
  }
}
