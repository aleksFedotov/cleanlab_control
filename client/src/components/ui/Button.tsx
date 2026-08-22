'use client';

import { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  icon,
  children,
  disabled,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    styles[variant],
    size === 'sm' ? styles.sm : '',
    className || '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={cls} disabled={disabled || busy} {...rest}>
      {busy ? (
        <Loader2 size={16} className={styles.spinner} aria-hidden />
      ) : (
        icon && <span className={styles.icon}>{icon}</span>
      )}
      {children}
    </button>
  );
}
