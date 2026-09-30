import { CentralRegistry, type RegistryStorage } from '~/server/centralRegistry';

let singleton: CentralRegistry | null = null;

interface LockNavigator {
  locks?: {
    request<T>(name: string, opts: { mode: 'exclusive' | 'shared' }, callback: () => T | Promise<T>): Promise<T>;
  };
}

/**
 * 中央登记账本的浏览器侧单例。
 *
 * 原型用 localStorage 模拟中央服务的持久层：多标签页、刷新、断网恢复后
 * 账本都还在；登记写路径经由 CentralRegistry 的串行队列与 Web Lock 完成并发收口。
 */
export function useCentralRegistry(): CentralRegistry {
  if (singleton) return singleton;
  const storage: RegistryStorage = {
    getItem: (key) => (import.meta.client ? window.localStorage.getItem(key) : null),
    setItem: (key, value) => {
      if (import.meta.client) window.localStorage.setItem(key, value);
    },
    // 多管理员多标签页并发确认时，经浏览器 Web Locks 排队进入中央临界区
    navigatorLock: <T>(name: string, opts: { mode: 'exclusive' | 'shared' }, callback: () => T | Promise<T>) => {
      const nav = (import.meta.client ? globalThis.navigator : undefined) as LockNavigator | undefined;
      if (nav?.locks?.request) return nav.locks.request(name, opts, callback);
      return Promise.resolve(callback());
    }
  };
  singleton = new CentralRegistry(storage);
  return singleton;
}

/** 仅测试用：替换单例（内存账本） */
export function __setCentralRegistryForTest(registry: CentralRegistry | null) {
  singleton = registry;
}
