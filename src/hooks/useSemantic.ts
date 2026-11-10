import { useEffect, useState } from 'react';
import { getSemanticState, subscribeSemantic } from '../services';

export function useSemantic() {
  const [state, setState] = useState(getSemanticState);
  useEffect(() => subscribeSemantic(setState), []);
  return state;
}
