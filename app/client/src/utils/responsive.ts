export type ResponsiveMode = 'desktop' | 'tablet' | 'mobile';

export function getResponsiveMode(width: number): ResponsiveMode {
  if (width >= 1200) return 'desktop';
  if (width >= 768) return 'tablet';
  return 'mobile';
}
