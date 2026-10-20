// Undo and Redo for the editor. Each entry is a project snapshot (JSON text)
// and the revision of the project file that the snapshot is based on.
//
// The revision goes back with the snapshot. Thus, after the file changed on
// disk and Vida reloaded it, Undo returns to the old version *and* to the old
// revision, and a normal Save of that version is rejected as stale. Only Save
// as… or "Replace the file on disk" writes it.

export class History {
  constructor(limit = 100) {
    this.limit = limit;
    this.clear();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Call before each change. current is { json, revision } of the state before the change. */
  record(current) {
    this.undoStack.push(current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Returns the entry to restore, or null. current is the state now. */
  undo(current) {
    if (!this.canUndo) return null;
    this.redoStack.push(current);
    return this.undoStack.pop();
  }

  redo(current) {
    if (!this.canRedo) return null;
    this.undoStack.push(current);
    return this.redoStack.pop();
  }

  /**
   * Vida wrote the project file. Entries based on revision `from` are now
   * based on the new revision `to`, because Vida itself made that change.
   * Entries based on other revisions (from before a reload) stay stale.
   * After Save as… to a different file, every entry belongs to the new file.
   */
  saved(from, to, { otherFile = false } = {}) {
    for (const e of [...this.undoStack, ...this.redoStack]) {
      if (otherFile || e.revision === from) e.revision = to;
    }
  }
}
