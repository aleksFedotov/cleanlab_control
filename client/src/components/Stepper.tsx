'use client';

// Общий степпер с редактируемым значением (кнопки-шаги + ручной ввод).
// Вынесен из CompleteWashModal: переиспользуется в ManualCleanModal.
import styles from './stepper.module.css';

export function Stepper({
  value,
  steps,
  onStep,
  onValueChange,
  step = 1,
}: {
  value: number;
  steps: Array<{ delta: number; label: string }>;
  onStep: (delta: number) => void;
  onValueChange: (value: number) => void;
  step?: number;
}) {
  return (
    <div className={styles.stepper}>
      {steps.map((s) => (
        <button
          key={s.label}
          type="button"
          className={styles.stepperBtn}
          onClick={() => onStep(s.delta)}
        >
          {s.label}
        </button>
      ))}
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={step}
        className={styles.stepperInput}
        value={value === 0 ? '' : value}
        placeholder="0"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onValueChange(Number.isNaN(v) ? 0 : Math.max(0, v));
        }}
        onFocus={(e) => e.target.select()}
      />
    </div>
  );
}
