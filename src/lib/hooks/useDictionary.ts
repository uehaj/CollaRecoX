import { useCallback, useEffect, useRef, useState } from 'react';
import { buildWsUrl } from '@/lib/wsUrl';
import { DICT_LIMITS, pruneOldest, validateDictionaryEntry, type DictionaryEntry } from '@/lib/dictionaryCore';

// 固有名詞辞書の共有Yjs doc（全セッション共通のグローバル1冊。セッション別辞書は将来拡張）。
// 校正エディタ本文のdoc（transcribe-editor-v2-{sessionId}）とは別docだが、
// 同じHocuspocusサーバ（/api/yjs-ws）に接続する。
// 設計: docs/superpowers/specs/2026-07-02-dictionary-and-minutes-design.html セクション1.2/1.4
const DICTIONARY_DOC_NAME = 'collareco-dictionary';

// yjs/@hocuspocus/provider はSSR回避のため動的importで読み込む（CollaborativeEditorV2.tsxと同様の方針）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YMapType = any;

export type DictionaryStatus = 'connecting' | 'connected' | 'disconnected';

export type AddEntryResult = { ok: true } | { ok: false; reason: string };

export interface UseDictionaryResult {
  /** 登録済み辞書エントリ（createdAt降順=新しい順） */
  entries: DictionaryEntry[];
  /** 誤・正を検証したうえでY.Mapへ登録する。上限超過時は古いエントリから削除する */
  addEntry: (wrong: string, correct: string) => AddEntryResult;
  /** 指定した誤(wrong)のエントリを削除する */
  removeEntry: (wrong: string) => void;
  /** 辞書docへの接続状態 */
  status: DictionaryStatus;
}

/**
 * 固有名詞辞書（collareco-dictionary doc）へ接続するフック。
 * Y.Map("entries")（キー=誤、値={correct, createdAt}）を購読し、
 * 一覧・追加・削除の操作を提供する。他ユーザーの変更もobserverで即時反映される。
 */
export function useDictionary(): UseDictionaryResult {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [status, setStatus] = useState<DictionaryStatus>('connecting');
  const entriesMapRef = useRef<YMapType>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let provider: any = null;
    let entriesMap: YMapType = null;
    let syncEntries: (() => void) | null = null;

    Promise.all([import('yjs'), import('@hocuspocus/provider')]).then(([Y, { HocuspocusProvider }]) => {
      // Reactの厳格モード等でこの効果がすでに片付けられていれば何もしない（接続の二重生成を防ぐ）
      if (cancelled) return;

      const ydoc = new Y.Doc();
      const websocketUrl = buildWsUrl('/api/yjs-ws');
      console.log('[Dictionary] 🔗 Connecting to:', websocketUrl, 'doc:', DICTIONARY_DOC_NAME);
      provider = new HocuspocusProvider({
        url: websocketUrl,
        name: DICTIONARY_DOC_NAME,
        document: ydoc,
      });

      // 注意: HocuspocusProvider(doc単位のラッパー)は内部のwebsocketProviderが発する
      // 'status'イベントを転送しない(v3で転送されるのはconnect/close/disconnect/destroy/openのみ)。
      // 校正エディタ本体のprovider(CollaborativeEditorV2.tsx)もこれと同じ理由で'connect'を使っている。
      provider.on('connect', () => {
        console.log('[Dictionary] Connected');
        setStatus('connected');
      });
      provider.on('disconnect', (event: unknown) => {
        console.log('[Dictionary] Disconnected:', event);
        setStatus('disconnected');
      });
      provider.on('close', (event: unknown) => console.warn('[Dictionary] ⚠️ Connection closed:', event));

      entriesMap = ydoc.getMap('entries');
      entriesMapRef.current = entriesMap;

      syncEntries = () => {
        const list: DictionaryEntry[] = [];
        entriesMap.forEach((value: unknown, key: string) => {
          const v = value as { correct?: unknown; createdAt?: unknown } | null;
          if (v && typeof v.correct === 'string' && typeof v.createdAt === 'number') {
            list.push({ wrong: key, correct: v.correct, createdAt: v.createdAt });
          }
        });
        list.sort((a, b) => b.createdAt - a.createdAt); // createdAt降順（新しい順）
        setEntries(list);
      };
      syncEntries();
      entriesMap.observe(syncEntries);
    });

    return () => {
      cancelled = true;
      if (entriesMap && syncEntries) {
        try { entriesMap.unobserve(syncEntries); } catch { /* 未購読なら無視 */ }
      }
      entriesMapRef.current = null;
      if (provider) {
        try { provider.disconnect(); provider.destroy(); } catch { /* 破棄失敗は無視 */ }
      }
    };
  }, []);

  const addEntry = useCallback((wrong: string, correct: string): AddEntryResult => {
    const result = validateDictionaryEntry(wrong, correct);
    if (!result.ok) return result;
    const map = entriesMapRef.current;
    if (!map) return { ok: false, reason: '辞書に未接続です。しばらくしてから再試行してください' };

    map.set(result.wrong, { correct: result.correct, createdAt: Date.now() });

    // 上限超過時は古いcreatedAtから削除する（pruneOldestのdrop分をY.Mapから消す）
    const all: DictionaryEntry[] = [];
    map.forEach((value: unknown, key: string) => {
      const v = value as { correct: string; createdAt: number };
      all.push({ wrong: key, correct: v.correct, createdAt: v.createdAt });
    });
    const { drop } = pruneOldest(all, DICT_LIMITS.maxEntries);
    drop.forEach((entry) => map.delete(entry.wrong));

    return { ok: true };
  }, []);

  const removeEntry = useCallback((wrong: string) => {
    entriesMapRef.current?.delete(wrong);
  }, []);

  return { entries, addEntry, removeEntry, status };
}
