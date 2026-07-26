export interface AnnotationSaveResult {
  hasNewerDraft: boolean;
}

export class AnnotationSaveTracker {
  private readonly pending = new Map<string, string>();
  private readonly drafts = new Map<string, string>();

  begin(nodeId: string, value: string): boolean {
    if (this.pending.has(nodeId)) {
      return false;
    }
    this.pending.set(nodeId, value);
    return true;
  }

  setDraft(nodeId: string, value: string): void {
    this.drafts.set(nodeId, value);
  }

  isPending(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }

  hasDraft(nodeId: string): boolean {
    return this.drafts.has(nodeId);
  }

  hasNewerPendingDraft(nodeId: string): boolean {
    const pending = this.pending.get(nodeId);
    const draft = this.drafts.get(nodeId);
    return pending !== undefined && draft !== undefined && draft !== pending;
  }

  finish(nodeId: string, saved: string | null): AnnotationSaveResult {
    const submitted = this.pending.get(nodeId);
    this.pending.delete(nodeId);
    const draft = this.drafts.get(nodeId);
    const hasNewerDraft =
      draft !== undefined && draft !== (submitted ?? saved ?? '');
    if (!hasNewerDraft) {
      this.drafts.delete(nodeId);
    }
    return { hasNewerDraft };
  }

  fail(nodeId: string): void {
    this.pending.delete(nodeId);
  }

  clear(): void {
    this.pending.clear();
    this.drafts.clear();
  }
}
