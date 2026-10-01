// Подписка этого браузера на Web Push и показ оповещений.
import { api } from './api';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function b64ToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Запросить разрешение и подписать браузер. Возвращает текст ошибки или null. */
export async function subscribe(publicKey: string): Promise<string | null> {
  if (!pushSupported()) return 'Браузер не поддерживает оповещения';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Оповещения запрещены в настройках браузера для этого сайта';
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW());
  if (!reg) return 'Не удалось зарегистрировать service worker';
  await navigator.serviceWorker.ready;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api.post('/notify/subscribe', { subscription: sub.toJSON() });
    return null;
  } catch (e: any) {
    return `Не удалось подписаться: ${e?.message || e}`;
  }
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.post('/notify/unsubscribe', { endpoint: sub.endpoint }).catch(() => null);
  await sub.unsubscribe();
}

/** Показать оповещение из открытой вкладки (когда браузер не подписан на push) */
export async function showLocal(title: string, body: string, tag: string, taskId: number | null, url?: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) await reg.showNotification(title, { body, tag, icon: '/favicon.svg', data: { taskId, url: url || null } });
  else new Notification(title, { body, tag, icon: '/favicon.svg' });
}
