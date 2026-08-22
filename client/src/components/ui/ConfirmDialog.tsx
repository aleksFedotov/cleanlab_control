'use client';

import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  text: string;
  okLabel: string;
  danger?: boolean;
  busy?: boolean;
}

export function ConfirmDialog({ open, onClose, onConfirm, text, okLabel, danger = false, busy = false }: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Подтверждение"
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {okLabel}
          </Button>
        </>
      }
    >
      {text}
    </Modal>
  );
}
