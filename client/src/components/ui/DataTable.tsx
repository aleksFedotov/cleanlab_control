'use client';

import { Fragment, ReactNode, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './DataTable.module.css';

export interface DataTableColumn {
  key: string;
  title: string;
  align?: 'left' | 'right';
  mono?: boolean;
  render?: (row: any) => ReactNode;
}

export interface DataTableProps {
  columns: DataTableColumn[];
  rows: any[];
  keyField: string;
  expandable?: (row: any) => ReactNode;
  empty?: ReactNode;
  onRowClick?: (row: any) => void;
}

export function DataTable({ columns, rows, keyField, expandable, empty, onRowClick }: DataTableProps) {
  const [expanded, setExpanded] = useState<string | number | null>(null);

  if (!rows.length) {
    return empty ? <>{empty}</> : null;
  }

  const toggle = (key: string | number) => setExpanded((cur) => (cur === key ? null : key));

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${styles.th} ${c.align === 'right' ? styles.right : ''} ${c.mono ? styles.mono : ''}`}
              >
                {c.title}
              </th>
            ))}
            {expandable && <th className={`${styles.th} ${styles.chevCol}`} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = row[keyField];
            const isOpen = expandable ? expanded === key : false;
            return (
              <Fragment key={key}>
                <tr
                  className={`${styles.tr} ${onRowClick || expandable ? styles.clickable : ''}`}
                  onClick={() => {
                    if (expandable) toggle(key);
                    onRowClick?.(row);
                  }}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`${styles.td} ${c.align === 'right' ? styles.right : ''} ${c.mono ? styles.mono : ''}`}
                    >
                      {c.render ? c.render(row) : row[c.key]}
                    </td>
                  ))}
                  {expandable && (
                    <td className={`${styles.td} ${styles.chevCol}`}>
                      <ChevronDown
                        size={16}
                        className={`${styles.chev} ${isOpen ? styles.chevOpen : ''}`}
                      />
                    </td>
                  )}
                </tr>
                {expandable && (
                  <tr className={styles.detailTr}>
                    <td colSpan={columns.length + 1} className={styles.detailTd}>
                      <div className={`${styles.detail} ${isOpen ? styles.detailOpen : ''}`}>
                        <div className={styles.detailInner}>{expandable(row)}</div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
