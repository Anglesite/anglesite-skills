/**
 * Shared git identity for commits Anglesite itself authors on the hidden
 * `refs/heads/anglesite/edits` branch (`edit-history.mjs`'s `recordEdit` and
 * `undo-edit.mjs`'s `undoEdit`). Both call `commit-tree` directly, which — unlike
 * `git commit` — never falls back to a "system default" identity: it needs
 * GIT_AUTHOR_* / GIT_COMMITTER_* env (or matching git config) or it fails outright
 * with "unable to auto-detect email address" in guest environments that have
 * neither (see #428). Centralized here so the two callers can't drift.
 */
export const ANGLESITE_COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Anglesite",
  GIT_AUTHOR_EMAIL: "edits@anglesite.local",
  GIT_COMMITTER_NAME: "Anglesite",
  GIT_COMMITTER_EMAIL: "edits@anglesite.local",
};
