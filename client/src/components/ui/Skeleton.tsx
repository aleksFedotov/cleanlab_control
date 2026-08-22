'use client';

import styles from './Skeleton.module.css';

export interface SkeletonProps {
  height?: number | string;
  width?: number | string;
  radius?: number | string;
  lines?: number;
}

function toCss(v: number | string | undefined): string | undefined {
  return typeof v === 'number' ? `${v}px` : v;
}

export function Skeleton({ height = 16, width, radius, lines }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <div className={styles.lines}>
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className={styles.block}
            style={{
              height: toCss(height),
              width: i === lines - 1 ? '60%' : '100%',
              borderRadius: toCss(radius),
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className={styles.block}
      style={{ height: toCss(height), width: toCss(width), borderRadius: toCss(radius) }}
    />
  );
}

export interface SkeletonCardsProps {
  count?: number;
}

export function SkeletonCards({ count = 3 }: SkeletonCardsProps) {
  return (
    <div className={styles.cards}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.cardSkel}>
          <Skeleton height={12} width="55%" />
          <Skeleton height={28} width="40%" />
          <Skeleton height={12} width="70%" />
        </div>
      ))}
    </div>
  );
}
