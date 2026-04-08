// ══════════════════════════════════════════════════════════════════════════════
//  RECON ENGINE — IndexedDB Module  v17-pwa
//  Lightweight async/await wrapper. Zero dependencies. Zero libraries.
//
//  Database: reconDB  (version 3)
//  Stores:
//    transactions  — all GL + BANK rows (keyed by id)
//    matches       — matched groups (keyed by match_id)
//    unmatched     — open/residual transactions (keyed by id)
//    settings      — app configuration (keyed by key)
//    sync_queue    — pending sync records (keyed by id, auto-increment)
//    snapshots     — per-bank snapshots for PersistenceEngine (keyed by bankId)
//    metadata      — single-row metadata (keyed by key)
//    intelligence  — intelligence patterns store (keyed by id)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const ReconDB = (() => {

  const DB_NAME    = 'reconDB';
  const DB_VERSION = 3;

  let _db = null;

  // ── Store definitions ────────────────────────────────────────────────────────
  const STORES = {
    transactions: { keyPath: 'id', indexes: [
      { name: 'by_source',   keyPath: 'source',   unique: false },
      { name: 'by_status',   keyPath: 'status',   unique: false },
      { name: 'by_bank',     keyPath: '_bankId',  unique: false },
      { name: 'by_date',     keyPath: '_dateStr', unique: false },
    ]},
    matches: { keyPath: 'match_id', indexes: [
      { name: 'by_type',     keyPath: 'match_type', unique: false },
      { name: 'by_bank',     keyPath: '_bankId',    unique: false },
      { name: 'by_lifecycle',keyPath: 'lifecycle',  unique: false },
    ]},
    unmatched: { keyPath: 'id', indexes: [
      { name: 'by_source',   keyPath: 'source',  unique: false },
      { name: 'by_bank',     keyPath: '_bankId', unique: false },
    ]},
    settings:     { keyPath: 'key'  },
    sync_queue:   { keyPath: 'id', autoIncrement: true, indexes: [
      { name: 'by_status',  keyPath: 'status', unique: false },
      { name: 'by_bank',    keyPath: 'bankId', unique: false },
    ]},
    snapshots:    { keyPath: 'bankId' },
    metadata:     { keyPath: 'key'    },
    intelligence: { keyPath: 'id'     },
  };

  // ── Open / upgrade database ──────────────────────────────────────────────────
  function initDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = event => {
        const db = event.target.result;
        const tx = event.target.transaction;
        console.log(`[ReconDB] Upgrading from v${event.oldVersion} → v${DB_VERSION}`);

        // Create or update each store
        Object.entries(STORES).forEach(([storeName, config]) => {
          let store;
          if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName, {
              keyPath:       config.keyPath,
              autoIncrement: config.autoIncrement || false,
            });
            console.log(`[ReconDB] Created store: ${storeName}`);
          } else {
            store = tx.objectStore(storeName);
          }

          // Create indexes
          (config.indexes || []).forEach(idx => {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
            }
          });
        });
      };

      req.onsuccess = event => {
        _db = event.target.result;

        // Handle unexpected version changes
        _db.onversionchange = () => {
          _db.close();
          _db = null;
          console.warn('[ReconDB] Database version changed — please reload.');
          window.dispatchEvent(new CustomEvent('recondb:versionchange'));
        };

        console.log(`[ReconDB] Ready — v${DB_VERSION}`);
        resolve(_db);
      };

      req.onerror = event => {
        console.error('[ReconDB] Open error:', event.target.error);
        reject(event.target.error);
      };

      req.onblocked = () => {
        console.warn('[ReconDB] Open blocked — another tab may have an older version open.');
      };
    });
  }

  // ── Low-level transaction helper ─────────────────────────────────────────────
  function _tx(storeNames, mode, fn) {
    return initDB().then(db => {
      return new Promise((resolve, reject) => {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const tx    = db.transaction(names, mode);
        tx.onerror  = e => reject(e.target.error);
        resolve(fn(tx));
      });
    });
  }

  // ── Generic CRUD helpers ─────────────────────────────────────────────────────

  /** Put one or many records into a store */
  function _putAll(storeName, records) {
    if (!records || (Array.isArray(records) && !records.length)) return Promise.resolve(0);
    const arr = Array.isArray(records) ? records : [records];
    return _tx(storeName, 'readwrite', tx => {
      const store = tx.objectStore(storeName);
      return Promise.all(arr.map(rec => new Promise((res, rej) => {
        const r = store.put(rec);
        r.onsuccess = () => res(r.result);
        r.onerror   = e => rej(e.target.error);
      })));
    });
  }

  /** Get all records from a store */
  function _getAll(storeName, indexName, query) {
    return _tx(storeName, 'readonly', tx => {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(storeName);
        const source = (indexName && store.indexNames.contains(indexName))
          ? store.index(indexName)
          : store;
        const req = query !== undefined ? source.getAll(query) : source.getAll();
        req.onsuccess = e => resolve(e.target.result || []);
        req.onerror   = e => reject(e.target.error);
      });
    });
  }

  /** Get single record by key */
  function _get(storeName, key) {
    return _tx(storeName, 'readonly', tx => {
      return new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror   = e => reject(e.target.error);
      });
    });
  }

  /** Delete records by key or IDBKeyRange */
  function _delete(storeName, key) {
    return _tx(storeName, 'readwrite', tx => {
      return new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror   = e => reject(e.target.error);
      });
    });
  }

  /** Clear all records in a store */
  function _clear(storeName) {
    return _tx(storeName, 'readwrite', tx => {
      return new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve(true);
        req.onerror   = e => reject(e.target.error);
      });
    });
  }

  /** Count records in a store */
  function _count(storeName, indexName, query) {
    return _tx(storeName, 'readonly', tx => {
      return new Promise((resolve, reject) => {
        const store  = tx.objectStore(storeName);
        const source = (indexName && store.indexNames.contains(indexName))
          ? store.index(indexName)
          : store;
        const req = query !== undefined ? source.count(query) : source.count();
        req.onsuccess = e => resolve(e.target.result || 0);
        req.onerror   = e => reject(e.target.error);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — TRANSACTIONS
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Save transactions for a bank. Adds _bankId and _dateStr metadata fields.
   * @param {string} bankId
   * @param {Array}  data  — array of transaction objects
   */
  function saveTransactions(bankId, data) {
    if (!bankId || !Array.isArray(data)) return Promise.resolve();
    const records = data.map(t => ({
      ...t,
      _bankId:  bankId,
      _dateStr: t.date instanceof Date
        ? t.date.toISOString().split('T')[0]
        : (t.date ? String(t.date).split('T')[0] : ''),
    }));
    return _putAll('transactions', records);
  }

  /**
   * Get all transactions for a bank.
   * @param {string} bankId
   */
  function getTransactions(bankId) {
    if (!bankId) return _getAll('transactions');
    return _getAll('transactions', 'by_bank', IDBKeyRange.only(bankId));
  }

  /**
   * Get transactions filtered by status.
   * @param {string} bankId
   * @param {string} status — 'OPEN' | 'MATCHED'
   */
  function getTransactionsByStatus(bankId, status) {
    return getTransactions(bankId).then(txns =>
      txns.filter(t => t.status === status)
    );
  }

  /**
   * Delete all transactions for a bank.
   */
  function clearTransactions(bankId) {
    if (!bankId) return _clear('transactions');
    return getTransactions(bankId).then(txns =>
      Promise.all(txns.map(t => _delete('transactions', t.id)))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — MATCHES
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Save match records for a bank.
   * @param {string} bankId
   * @param {Array}  data  — array of match objects
   */
  function saveMatches(bankId, data) {
    if (!bankId || !Array.isArray(data)) return Promise.resolve();
    const records = data.map(m => ({ ...m, _bankId: bankId }));
    return _putAll('matches', records);
  }

  /**
   * Get all matches for a bank.
   */
  function getMatches(bankId) {
    if (!bankId) return _getAll('matches');
    return _getAll('matches', 'by_bank', IDBKeyRange.only(bankId));
  }

  /**
   * Delete all matches for a bank.
   */
  function clearMatches(bankId) {
    if (!bankId) return _clear('matches');
    return getMatches(bankId).then(matches =>
      Promise.all(matches.map(m => _delete('matches', m.match_id)))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — UNMATCHED
  // ══════════════════════════════════════════════════════════════════════════════

  function saveUnmatched(bankId, data) {
    if (!bankId || !Array.isArray(data)) return Promise.resolve();
    const records = data.map(t => ({ ...t, _bankId: bankId }));
    return _putAll('unmatched', records);
  }

  function getUnmatched(bankId) {
    if (!bankId) return _getAll('unmatched');
    return _getAll('unmatched', 'by_bank', IDBKeyRange.only(bankId));
  }

  function clearUnmatched(bankId) {
    if (!bankId) return _clear('unmatched');
    return getUnmatched(bankId).then(items =>
      Promise.all(items.map(i => _delete('unmatched', i.id)))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — SNAPSHOTS (used by PersistenceEngine as its backing store)
  // ══════════════════════════════════════════════════════════════════════════════

  function saveSnapshot(bankId, snapshot) {
    return _putAll('snapshots', { bankId, ...snapshot, _savedAt: new Date().toISOString() });
  }

  function getSnapshot(bankId) {
    return _get('snapshots', bankId);
  }

  function deleteSnapshot(bankId) {
    return _delete('snapshots', bankId);
  }

  function getAllSnapshots() {
    return _getAll('snapshots');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — SETTINGS
  // ══════════════════════════════════════════════════════════════════════════════

  function saveSetting(key, value) {
    return _putAll('settings', { key, value, _updatedAt: new Date().toISOString() });
  }

  async function getSetting(key, defaultValue = null) {
    const rec = await _get('settings', key);
    return rec ? rec.value : defaultValue;
  }

  function getAllSettings() {
    return _getAll('settings').then(rows =>
      Object.fromEntries(rows.map(r => [r.key, r.value]))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — SYNC QUEUE
  // ══════════════════════════════════════════════════════════════════════════════

  const SYNC_STATUS = { PENDING: 'pending', SYNCED: 'synced', FAILED: 'failed' };

  /**
   * Enqueue a record for sync.
   * @param {string} bankId
   * @param {string} type    — 'match' | 'unmatch' | 'file_load' | 'clear'
   * @param {*}      payload — serialisable payload
   */
  function enqueueSync(bankId, type, payload) {
    const record = {
      bankId,
      type,
      payload,
      status:    SYNC_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      attempts:  0,
    };
    return _putAll('sync_queue', record).then(([id]) => id);
  }

  function getPendingSyncItems(bankId) {
    return _getAll('sync_queue', 'by_status', IDBKeyRange.only(SYNC_STATUS.PENDING))
      .then(items => bankId ? items.filter(i => i.bankId === bankId) : items);
  }

  function markSynced(id) {
    return _get('sync_queue', id).then(rec => {
      if (!rec) return;
      rec.status   = SYNC_STATUS.SYNCED;
      rec.syncedAt = new Date().toISOString();
      return _putAll('sync_queue', rec);
    });
  }

  function markSyncFailed(id, error) {
    return _get('sync_queue', id).then(rec => {
      if (!rec) return;
      rec.status   = SYNC_STATUS.FAILED;
      rec.attempts = (rec.attempts || 0) + 1;
      rec.lastError = String(error);
      return _putAll('sync_queue', rec);
    });
  }

  function clearSyncedItems() {
    return _getAll('sync_queue', 'by_status', IDBKeyRange.only(SYNC_STATUS.SYNCED))
      .then(items => Promise.all(items.map(i => _delete('sync_queue', i.id))));
  }

  function getPendingSyncCount() {
    return _count('sync_queue', 'by_status', IDBKeyRange.only(SYNC_STATUS.PENDING));
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════════

  function saveIntelligence(data) {
    if (!data) return Promise.resolve();
    return _putAll('intelligence', { id: 'main', ...data, _savedAt: new Date().toISOString() });
  }

  function getIntelligence() {
    return _get('intelligence', 'main');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — METADATA
  // ══════════════════════════════════════════════════════════════════════════════

  function saveMeta(key, value) {
    return _putAll('metadata', { key, value });
  }

  function getMeta(key) {
    return _get('metadata', key).then(r => r ? r.value : null);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — CLEAR DATA
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Clear all data for a bank, or all data if bankId is omitted.
   */
  async function clearData(bankId) {
    if (bankId) {
      await Promise.all([
        clearTransactions(bankId),
        clearMatches(bankId),
        clearUnmatched(bankId),
        deleteSnapshot(bankId),
      ]);
    } else {
      await Promise.all([
        _clear('transactions'),
        _clear('matches'),
        _clear('unmatched'),
        _clear('snapshots'),
        _clear('sync_queue'),
        _clear('metadata'),
      ]);
    }
    console.log(`[ReconDB] Cleared data${bankId ? ` for bank: ${bankId}` : ' (all)'}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — STATS
  // ══════════════════════════════════════════════════════════════════════════════

  async function getStats() {
    await initDB();
    const [txns, matches, unmatched, pending] = await Promise.all([
      _count('transactions'),
      _count('matches'),
      _count('unmatched'),
      getPendingSyncCount(),
    ]);
    return { transactions: txns, matches, unmatched, pendingSync: pending };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — ESTIMATE STORAGE
  // ══════════════════════════════════════════════════════════════════════════════

  async function estimateStorage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        return {
          usedMB:  (usage  / 1048576).toFixed(2),
          quotaMB: (quota  / 1048576).toFixed(0),
          pct:     quota ? ((usage / quota) * 100).toFixed(1) : '—',
        };
      }
    } catch(_) {}
    return { usedMB: '—', quotaMB: '—', pct: '—' };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════════════════════════════════════════════
  return {
    // Lifecycle
    initDB,

    // Transactions
    saveTransactions,
    getTransactions,
    getTransactionsByStatus,
    clearTransactions,

    // Matches
    saveMatches,
    getMatches,
    clearMatches,

    // Unmatched
    saveUnmatched,
    getUnmatched,
    clearUnmatched,

    // Snapshots (PersistenceEngine backing)
    saveSnapshot,
    getSnapshot,
    deleteSnapshot,
    getAllSnapshots,

    // Settings
    saveSetting,
    getSetting,
    getAllSettings,

    // Sync Queue
    enqueueSync,
    getPendingSyncItems,
    markSynced,
    markSyncFailed,
    clearSyncedItems,
    getPendingSyncCount,
    SYNC_STATUS,

    // Intelligence
    saveIntelligence,
    getIntelligence,

    // Metadata
    saveMeta,
    getMeta,

    // Utilities
    clearData,
    getStats,
    estimateStorage,
  };
})();

// Make globally available (matches the single-file architecture of recon_v17)
if (typeof window !== 'undefined') {
  window.ReconDB = ReconDB;
}
