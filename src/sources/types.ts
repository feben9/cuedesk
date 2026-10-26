import type { Stage } from '../store/types.ts';
import type { StageMap } from '../config/types.ts';

/** One unit of tracked work, as a source reports it. */
export interface SourceItem {
  id: string;
  title: string;
  /** The tracker's own status text, e.g. "In Testing" or "draft PR". */
  status: string;
  stage: Stage;
  url: string | null;
  assignee: string | null;
  /** Last update in the tracker, epoch ms. Null when the tracker gives none. */
  updatedAt: number | null;
}

/** A read-only view of a tracker. Cue polls it; it never writes back in v0.1. */
export interface Source {
  readonly name: string;
  readonly type: string;
  fetchItems(): Promise<SourceItem[]>;
  close?(): Promise<void>;
}

/** Maps a tracker status (or label) to a Cue stage, ignoring case and spacing. */
export function stageFor(status: string, stages: StageMap): Stage | null {
  const key = status.trim().toLowerCase();
  for (const [stage, names] of Object.entries(stages)) {
    if (names?.some((n) => n.trim().toLowerCase() === key)) return stage as Stage;
  }
  return null;
}
