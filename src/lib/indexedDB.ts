// IndexedDB ユーティリティ for 録音データ保存

const DB_NAME = 'dummy-audio-recordings-db';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

export interface AudioRecording {
  id: string;
  name: string;
  timestamp: number;
  duration: number;
  data: string; // Base64 encoded PCM16 data
  sampleRate: number;
}

// データベースを開く
const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[IndexedDB] Error opening database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // オブジェクトストアが存在しない場合は作成
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[IndexedDB] Object store created');
      }
    };
  });
};

// すべての録音を取得
export const getAllRecordings = async (): Promise<AudioRecording[]> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => {
        console.error('[IndexedDB] Error getting recordings:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        // タイムスタンプの降順でソート（新しい順）
        const recordings = request.result.sort((a, b) => b.timestamp - a.timestamp);
        console.log('[IndexedDB] Retrieved', recordings.length, 'recordings');
        resolve(recordings);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  } catch (error) {
    console.error('[IndexedDB] Error in getAllRecordings:', error);
    return [];
  }
};

// 録音を保存
export const saveRecording = async (recording: AudioRecording): Promise<void> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(recording);

      request.onerror = () => {
        console.error('[IndexedDB] Error saving recording:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        console.log('[IndexedDB] Saved recording:', recording.id);
        resolve();
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  } catch (error) {
    console.error('[IndexedDB] Error in saveRecording:', error);
    throw error;
  }
};

// 録音を削除
export const deleteRecording = async (id: string): Promise<void> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => {
        console.error('[IndexedDB] Error deleting recording:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        console.log('[IndexedDB] Deleted recording:', id);
        resolve();
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  } catch (error) {
    console.error('[IndexedDB] Error in deleteRecording:', error);
    throw error;
  }
};

// すべての録音を削除
export const deleteAllRecordings = async (): Promise<void> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => {
        console.error('[IndexedDB] Error clearing recordings:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        console.log('[IndexedDB] Cleared all recordings');
        resolve();
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  } catch (error) {
    console.error('[IndexedDB] Error in deleteAllRecordings:', error);
    throw error;
  }
};

// ストレージ使用量を取得（概算）
export const getStorageUsage = async (): Promise<{ usedMB: number; quotaMB: number }> => {
  try {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      const usedMB = (estimate.usage || 0) / (1024 * 1024);
      const quotaMB = (estimate.quota || 0) / (1024 * 1024);
      return { usedMB, quotaMB };
    }
    return { usedMB: 0, quotaMB: 0 };
  } catch (error) {
    console.error('[IndexedDB] Error getting storage estimate:', error);
    return { usedMB: 0, quotaMB: 0 };
  }
};
