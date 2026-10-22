/* IndexedDB persistence: books, chapter bodies, progress, bookmarks, cloud leftovers. */

const DB_NAME = 'moread';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chapters')) {
        const store = db.createObjectStore('chapters', { keyPath: ['bookId', 'index'] });
        store.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('bookmarks')) {
        const store = db.createObjectStore('bookmarks', { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('pendingProgress')) {
        db.createObjectStore('pendingProgress', { keyPath: 'hash' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('本地数据库被其他标签页占用，请关闭其他页面后重试'));
  });
  return dbPromise;
}

async function withStore(name, mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(name, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('本地数据库操作失败'));
    transaction.onabort = () => reject(transaction.error || new Error('本地数据库操作已取消'));
    try {
      result = operation(transaction.objectStore(name), transaction);
    } catch (error) {
      try { transaction.abort(); } catch { /* already aborted */ }
      reject(error);
    }
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listBooksWithProgress() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'progress'], 'readonly');
    const booksReq = tx.objectStore('books').getAll();
    const progressReq = tx.objectStore('progress').getAll();
    tx.oncomplete = () => {
      const progressMap = new Map(progressReq.result.map((item) => [item.bookId, item]));
      resolve(booksReq.result.map((book) => ({ ...book, progress: progressMap.get(book.id) || null })));
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBook(bookId) {
  return withStore('books', 'readonly', (store) => req(store.get(bookId)));
}

export async function putBook(book) {
  return withStore('books', 'readwrite', (store) => req(store.put(book)));
}

export async function saveBookWithChapters(book, chapters) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存书籍失败'));
    tx.onabort = () => reject(tx.error || new Error('保存书籍被中断'));
    tx.objectStore('books').put(book);
    const chapterStore = tx.objectStore('chapters');
    chapters.forEach((chapter, index) => {
      chapterStore.put({
        bookId: book.id,
        index,
        title: chapter.title,
        html: chapter.html,
        text: chapter.text,
        chars: chapter.chars,
      });
    });
  });
}

export async function getChapter(bookId, index) {
  return withStore('chapters', 'readonly', (store) => req(store.get([bookId, index])));
}

export async function getChapters(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chapters', 'readonly');
    const index = tx.objectStore('chapters').index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
    request.onerror = () => reject(request.error);
  });
}

export async function deleteBook(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters', 'progress', 'bookmarks'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('books').delete(bookId);
    tx.objectStore('progress').delete(bookId);
    const chapters = tx.objectStore('chapters').index('bookId').openKeyCursor(IDBKeyRange.only(bookId));
    chapters.onsuccess = () => {
      const cursor = chapters.result;
      if (cursor) {
        tx.objectStore('chapters').delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    const bookmarks = tx.objectStore('bookmarks').index('bookId').openKeyCursor(IDBKeyRange.only(bookId));
    bookmarks.onsuccess = () => {
      const cursor = bookmarks.result;
      if (cursor) {
        tx.objectStore('bookmarks').delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}

export async function getProgress(bookId) {
  return withStore('progress', 'readonly', (store) => req(store.get(bookId)));
}

export async function getAllProgress() {
  return withStore('progress', 'readonly', (store) => req(store.getAll()));
}

export async function saveProgress(progress) {
  return withStore('progress', 'readwrite', (store) => req(store.put(progress)));
}

/** Reset a book to its first page (keeps the book, clears its bookmarks). */
export async function resetBookProgress(bookId) {
  const zero = {
    bookId,
    chapterIndex: 0,
    chapterTitle: '',
    chapterCount: 0,
    pageIndex: 0,
    pageCount: 1,
    pageRatio: 0,
    scrollRatio: 0,
    chapterRatio: 0,
    percent: 0,
    finished: false,
    readingTime: 0,
    updatedAt: Date.now(),
    fromCloud: false,
  };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['progress', 'bookmarks'], 'readwrite');
    tx.oncomplete = () => resolve(zero);
    tx.onerror = () => reject(tx.error);
    tx.objectStore('progress').put(zero);
    const bookmarks = tx.objectStore('bookmarks').index('bookId').openKeyCursor(IDBKeyRange.only(bookId));
    bookmarks.onsuccess = () => {
      const cursor = bookmarks.result;
      if (cursor) {
        tx.objectStore('bookmarks').delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}

export async function getBookmarks(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const index = tx.objectStore('bookmarks').index('bookId');
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

export async function getAllBookmarks() {
  return withStore('bookmarks', 'readonly', (store) => req(store.getAll()));
}

export async function addBookmark(bookmark) {
  return withStore('bookmarks', 'readwrite', (store) => req(store.put(bookmark)));
}

export async function removeBookmark(bookmarkId) {
  return withStore('bookmarks', 'readwrite', (store) => req(store.delete(bookmarkId)));
}

export async function savePendingProgress(record) {
  if (!record?.hash) return;
  return withStore('pendingProgress', 'readwrite', (store) => req(store.put(record)));
}

export async function getPendingProgress(hash) {
  return withStore('pendingProgress', 'readonly', (store) => req(store.get(hash)));
}

export async function deletePendingProgress(hash) {
  return withStore('pendingProgress', 'readwrite', (store) => req(store.delete(hash)));
}

export async function applySyncedProgress(records) {
  if (!Array.isArray(records) || !records.length) return { applied: 0, pending: 0 };
  const db = await openDB();
  const books = await new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const request = tx.objectStore('books').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const localIds = new Set(books.map((book) => book.id));
  let applied = 0;
  let pending = 0;
  for (const remote of records) {
    if (!remote?.hash) continue;
    if (!localIds.has(remote.hash)) {
      await savePendingProgress(remote);
      pending += 1;
      continue;
    }
    const local = await getProgress(remote.hash);
    if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0) + 500) {
      const pageCount = Math.max(1, Number(remote.pageCount) || 1);
      const pageIndex = Math.max(0, Number(remote.pageIndex) || 0);
      const derivedRatio = pageCount > 1 ? pageIndex / (pageCount - 1) : 0;
      const chapterRatio = Math.max(0, Math.min(1,
        Number.isFinite(Number(remote.chapterRatio)) ? Number(remote.chapterRatio) : derivedRatio));
      await saveProgress({
        bookId: remote.hash,
        chapterIndex: Math.max(0, Number(remote.chapterIndex) || 0),
        chapterTitle: remote.chapterTitle || '',
        chapterCount: Math.max(1, Number(remote.chapterCount) || 1),
        pageIndex,
        pageCount,
        pageRatio: chapterRatio,
        scrollRatio: Math.max(0, Math.min(1, Number(remote.scrollRatio) || 0)),
        chapterRatio,
        percent: Math.max(0, Math.min(100, Number(remote.percent) || 0)),
        finished: Boolean(remote.finished),
        readingTime: Math.max(0, Number(remote.readingTime) || 0),
        updatedAt: Number(remote.updatedAt) || Date.now(),
        fromCloud: true,
      });
      applied += 1;
    }
  }
  return { applied, pending };
}

/** Used before overwriting a local book that was already imported. */
export async function saveProgressIfNewer(progress) {
  const existing = await getProgress(progress.bookId);
  if (!existing || (progress.updatedAt || 0) > (existing.updatedAt || 0)) {
    await saveProgress(progress);
    return true;
  }
  return false;
}

export { openDB };
