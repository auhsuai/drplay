import { PlayerAction, PlayerState } from './types';

export const initialPlayerState: PlayerState = {
  error: null,
  manualResume: false,
  pendingResumeTime: null,
};

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'PLAY_SUCCESS':
      return { error: null, manualResume: false, pendingResumeTime: null };
    case 'ERROR':
      return { ...state, error: action.error };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'BLOCKED':
      return { ...state, manualResume: true, pendingResumeTime: action.time };
    case 'RESUMED':
      return { error: null, manualResume: false, pendingResumeTime: null };
    case 'TRACK_CHANGE':
      return { error: null, manualResume: false, pendingResumeTime: null };
    default:
      return state;
  }
}
