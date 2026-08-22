'use client';

// Степпер «кнопки + значение» (порт legacy .stepper, server/public/index.html:627-637).
// Отрицательные шаги — слева от значения, положительные — справа.
// Значение кликабельно — открывает ручной ввод (NumInputModal на уровне страницы).
import styles from './wash-id.module.css';

export interface StepperProps {
  value: number | string;
  steps: Array<{ delta: number; label: string }>;
  onStep: (delta: number) => void;
  onValueClick?: () => void;
}

export function Stepper({ value, steps, onStep, onValueClick }: StepperProps) {
  const neg = steps.filter((s) => s.delta < 0);
  const pos = steps.filter((s) => s.delta >= 0);
  const btn = (s: { delta: number; label: string }) => (
    <button
      key={s.label}
      type="button"
      className={styles.stepperBtn}
      onClick={() => onStep(s.delta)}
    >
      {s.label}
    </button>
  );
  return (
    <div className={styles.stepper}>
      {neg.map(btn)}
      <span className={styles.stepperVal} title="Нажмите для ввода вручную" onClick={onValueClick}>
        {value}
      </span>
      {pos.map(btn)}
    </div>
  );
}
