import { EventEmitter } from 'node:events';

/** Внутренняя шина событий: sync/алерты -> SSE-клиенты */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export type BusEvent =
  | { type: 'tasks'; ids: number[] }
  | { type: 'alert'; alert: unknown }
  | { type: 'sync'; status: unknown };

export const emit = (e: BusEvent) => bus.emit('event', e);
