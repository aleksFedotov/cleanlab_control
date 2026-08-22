'use client';

// Модалка создания/переименования прачки (legacy: renderLaundries, server/public/index.html:1487).
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import styles from './laundry-form-modal.module.css';

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название прачки'),
});

type FormValues = z.infer<typeof schema>;

export interface LaundryFormModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  initialName?: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
}

export function LaundryFormModal({
  open,
  onClose,
  title,
  initialName = '',
  submitLabel,
  busy = false,
  onSubmit,
}: LaundryFormModalProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: initialName },
  });

  // При переоткрытии (другая прачка / режим) — сбросить форму на исходное имя.
  useEffect(() => {
    if (open) reset({ name: initialName });
  }, [open, initialName, reset]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" form="laundry-form" busy={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id="laundry-form"
        className={styles.form}
        onSubmit={handleSubmit((v) => onSubmit(v.name.trim()))}
        noValidate
      >
        <label className={styles.label} htmlFor="laundry-name">
          Название
        </label>
        <input id="laundry-name" autoFocus placeholder="Название" {...register('name')} />
        {errors.name && <div className={styles.error}>{errors.name.message}</div>}
      </form>
    </Modal>
  );
}
