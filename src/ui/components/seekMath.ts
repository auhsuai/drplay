export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
export const clamp01 = (value: number): number => clamp(value, 0, 1);
