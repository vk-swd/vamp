import { createContext } from 'react';

export interface DeleteTrackCtx {
  onDelete: (id: number) => Promise<void>;
}

export const DeleteTrackContext = createContext<DeleteTrackCtx>({ onDelete: () => Promise.resolve() });
