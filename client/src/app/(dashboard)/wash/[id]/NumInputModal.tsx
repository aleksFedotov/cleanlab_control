'use client';

// Ручной ввод числа по нажатию на значение степпера
// (legacy openNumInput, server/public/index.html:812-828).
// Пустой ввод = оставить текущее значение.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

const schema = z.object({ value: z.string() });

type FormValues = z.infer<typeof schema>;

export interface NumInputModalProps {
  title: string;
  current: number | string;
  isFloat: boolean;
  onOk: (v: number) => void;
  onClose: () => void;
}

export function NumInputModal({ title, current, isFloat, onOk, onClose }: NumInputModalProps) {
  const { register, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { value: '' },
  });

  const onSubmit = handleSubmit((v) => {
    const raw = String(v.value).replace(',', '.').trim();
    let num = raw === '' ? parseFloat(String(current)) || 0 : parseFloat(raw) || 0;
    num = isFloat ? Math.max(0, Math.round(num * 10) / 10) : Math.max(0, Math.floor(num));
    onOk(num);
    onClose();
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={onSubmit}>Сохранить</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          type="number"
          inputMode="decimal"
          placeholder={String(current)}
          step={isFloat ? '0.1' : '1'}
          min="0"
          autoFocus
          {...register('value')}
        />
      </form>
    </Modal>
  );
}
