// ブラウザ内蔵のオンデバイスLLM（Chrome=Gemini Nano / Edge=Phi 等）への
// ブラウザ非依存アクセス。Node では使えずブラウザ専用。実験的APIで lib.dom に
// 型がないため、必要最小限の型を自前で宣言する。
// 録音画面（自動校正エンジン）と校正画面（AI編集エンジン）の双方から共有する。

export interface NanoPromptSession {
  prompt: (input: string) => Promise<string>;
  destroy?: () => void;
}

export interface NanoPromptMonitor {
  addEventListener: (type: string, cb: (e: { loaded?: number; total?: number }) => void) => void;
}

export type NanoAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface NanoLanguageModel {
  availability: () => Promise<NanoAvailability>;
  create: (opts?: {
    initialPrompts?: { role: string; content: string }[];
    monitor?: (m: NanoPromptMonitor) => void;
  }) => Promise<NanoPromptSession>;
}

// 検出結果。APIそのものが無い場合は 'unsupported'、それ以外は availability() の値。
export type BrowserLlmState = 'unsupported' | NanoAvailability;

// self.LanguageModel（Chrome/Edge 標準の Prompt API 面）→ self.ai.languageModel（旧/汎用）の順に探す。
// ブラウザ非依存: Chrome=Gemini Nano、Edge=Phi、いずれも同一インターフェース。UA判定はしない。
export const getBrowserLanguageModel = (): NanoLanguageModel | null => {
  if (typeof self === 'undefined') return null;
  const w = self as unknown as { LanguageModel?: NanoLanguageModel; ai?: { languageModel?: NanoLanguageModel } };
  return w.LanguageModel || w.ai?.languageModel || null;
};

// マウント時の対応検出。APIが無ければ 'unsupported'、それ以外は availability() の値を返す。
export const probeBrowserLlm = async (): Promise<BrowserLlmState> => {
  const LM = getBrowserLanguageModel();
  if (!LM) return 'unsupported';
  try {
    return await LM.availability();
  } catch {
    return 'unsupported';
  }
};

// 選択時のダウンロードゲート: モデルを 'available' まで用意する。
// 'downloadable'/'downloading' のときは create({monitor}) でDLを起動し、完了まで待って進捗を通知する。
// 完了後に availability() が 'available' になることを確認する。
// 例外（未対応・DL失敗・準備未完）は呼び出し側で握り、フォールバックせず警告表示する方針。
export const ensureBrowserLlmReady = async (onProgress?: (loaded: number) => void): Promise<void> => {
  const LM = getBrowserLanguageModel();
  if (!LM) throw new Error('このブラウザはオンデバイスAIに未対応です');
  const avail = await LM.availability();
  if (avail === 'unavailable') {
    throw new Error('オンデバイスAIが利用できません（フラグ未設定・非対応環境・ディスク不足など）');
  }
  if (avail === 'available') return;
  // downloadable / downloading: create でDLを起動し、完了まで待つ（このセッションはDL確認用なので破棄する）
  const session = await LM.create({
    monitor: (m) => {
      m.addEventListener('downloadprogress', (e) => {
        if (typeof e.loaded === 'number' && onProgress) onProgress(e.loaded);
      });
    },
  });
  session.destroy?.();
  const after = await LM.availability();
  if (after !== 'available') {
    throw new Error('モデルの準備が完了しませんでした（再度お試しください）');
  }
};
