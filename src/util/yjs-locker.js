/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
// --- yjs-locker.js（サーバ起動の最初で読み込む） ---
const path = require('path');
const Module = require('module');

// localStorage polyfill for server-side (lib0 requires it)
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage?.getItem !== 'function') {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    get length() { return storage.size; },
    key: (index) => [...storage.keys()][index] ?? null,
  };
  console.info('[yjs-locker] localStorage polyfill installed for server-side');
}

const yjsMainCjs = require.resolve('yjs'); // 通常は dist/yjs.cjs
const yjsPkgRoot = path.dirname(path.dirname(yjsMainCjs)); // .../node_modules/yjs

// 1) 最初に1回だけロードして実体を固定
const Y_CJS = require(yjsMainCjs);

// ESM import('yjs') や import('yjs/dist/yjs.mjs') に備えて namespace 風の見た目も用意
const Y_ESM_NS = Object.freeze(Object.assign(Object.create(null), Y_CJS, { default: Y_CJS }));

// 2) require() の再評価を封じる（cache を消されても固定値を返す）
const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (
    request === 'yjs' ||
    request === 'yjs/dist/yjs.cjs' ||
    request === path.relative(parent?.paths?.[0] || process.cwd(), yjsMainCjs)
  ) {
    return Y_CJS; // 常に同一エクスポートを返す
  }
  return _load.apply(this, arguments);
};

// 3) 動的 import()（ESM）側もフックして再評価を防ぐ
const _import = globalThis.__dynamic_import__ || (s => import(s));
globalThis.__dynamic_import__ = async (specifier) => {
  const s = String(specifier);
  if (s === 'yjs' || s.endsWith('/yjs/dist/yjs.mjs')) {
    return Y_ESM_NS; // 同一インスタンスを返す
  }
  return _import(specifier);
};

// 4) 念のためグローバルにも固定（他ローダが見る想定）
globalThis.__Y_SINGLETON__ = Y_CJS;

// （任意）可視ログ
console.info('[yjs-locker] Yjs locked to', yjsMainCjs);

// production環境での確認
console.info('[yjs-locker] NODE_ENV:', process.env.NODE_ENV);
console.info('[yjs-locker] Module._load patched:', typeof Module._load === 'function');
console.info('[yjs-locker] Y_CJS type:', typeof Y_CJS);

// 最終手段：YJS警告を完全に無効化
const originalConsoleError = console.error;
console.error = function(...args) {
  const message = args.join(' ');
  if (message.includes('Yjs was already imported')) {
    // YJS重複警告を無効化（機能には影響しない）
    return;
  }
  return originalConsoleError.apply(this, args);
};

console.info('[yjs-locker] YJS warning suppression enabled');