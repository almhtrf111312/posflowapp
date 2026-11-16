import type React from 'react';

export type ThemeTransitionEvent = 
  | React.MouseEvent<HTMLElement>
  | React.TouchEvent<HTMLElement>
  | MouseEvent
  | TouchEvent
  | null
  | undefined;
