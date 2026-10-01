import { ABSENCE_TYPES, fmtYmdShort, type Employee } from '../api';

/** «Отпуск до 14.10» — если отсутствует сейчас, «Отпуск с 20.10» — если скоро */
export function AbsenceBadge({ employee, compact }: { employee: Employee; compact?: boolean }) {
  const now = employee.absence_now;
  const next = employee.absence_next;
  const a = now || next;
  if (!a) return null;
  const t = ABSENCE_TYPES[a.type];
  const text = now ? `${t.label} до ${fmtYmdShort(a.date_to)}` : `${t.label} с ${fmtYmdShort(a.date_from)}`;
  return (
    <span
      className={`chip absence-chip ${now ? 'now' : ''}`}
      style={{ ['--abs' as string]: t.color }}
      title={`${t.label}: ${fmtYmdShort(a.date_from)} – ${fmtYmdShort(a.date_to)}${a.comment ? ` · ${a.comment}` : ''}`}
    >
      {compact ? (now ? t.label : `с ${fmtYmdShort(a.date_from)}`) : text}
    </span>
  );
}
