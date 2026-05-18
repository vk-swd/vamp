import { Widget, Label, Button } from './elements';

export interface PendingTask {
  description: string;
  createdAt: Date;
  error: string | null;
}

export interface PendingTasksWidgetProps {
  tasks: Map<string, PendingTask>;
  onClearLastError: () => void;
}

export function PendingTasksWidget({ tasks, onClearLastError }: PendingTasksWidgetProps) {
  const entries    = [...tasks.entries()];
  const inProgress = entries.filter(([, t]) => t.error === null);
  const errored    = entries.filter(([, t]) => t.error !== null);

  if (tasks.size === 0) return null;

  const lastInProgress = inProgress[inProgress.length - 1]?.[1] ?? null;
  const lastError      = errored[errored.length - 1]?.[1] ?? null;
  const isError        = !lastInProgress && !!lastError;
  const shownText      = lastInProgress
    ? lastInProgress.description
    : (lastError!.error ?? lastError!.description);

  return (
    <Widget style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-sp-2)', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-sp-2)', flex: 1, minWidth: 0 }}>
        {inProgress.length > 0 && (
          <Label variant="muted">{inProgress.length} in progress</Label>
        )}
        {errored.length > 0 && (
          <Label variant="error">⚠ {errored.length} error{errored.length !== 1 ? 's' : ''}</Label>
        )}
        <Label
          variant={isError ? 'error' : 'muted'}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {shownText}
        </Label>
      </div>
      {errored.length > 0 && (
        <Button variant="ghost" size="sm" onClick={onClearLastError} title="Clear last error">🗑</Button>
      )}
    </Widget>
  );
}
