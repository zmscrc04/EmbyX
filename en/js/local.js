/**
 * EmbyX Local Folder Mode
 * File System Access API + NFO/sidecar image parsing
 */
(function (window) {
    'use strict';

    const VIDEO_EXT = new Set([
        'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'mts',
        'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv', 'rmvb', 'vob'
    ]);
    const IMAGE_NAMES = [
        'poster', 'folder', 'cover', 'thumb', 'fanart', 'banner',
        'poster.jpg', 'poster.png', 'poster.webp',
        'folder.jpg', 'folder.png', 'cover.jpg', 'thumb.jpg', 'fanart.jpg'
    ];
    const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);
    const IDB_NAME = 'embyx_local';
    const IDB_VERSION = 1;
    const STORE_HANDLES = 'handles';
    const STORE_LIBRARY = 'library';

    function extOf(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    }
    function baseName(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(0, i) : name;
    }
    function simpleHash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return 'local_' + Math.abs(h).toString(36) + '_' + str.length.toString(36);
    }

    function openDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject(new Error('IndexedDB not available'));
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
                if (!db.objectStoreNames.contains(STORE_LIBRARY)) db.createObjectStore(STORE_LIBRARY);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function idbGet(store, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function idbSet(store, key, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            const req = tx.objectStore(store).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
    async function idbDel(store, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            const req = tx.objectStore(store).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    function isSupported() {
        return typeof window.showDirectoryPicker === 'function';
    }
    async function pickDirectory() {
        if (!isSupported()) throw new Error('当前浏览器不支持本地文件夹选择，请使用 Chrome / Edge');
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        await idbSet(STORE_HANDLES, 'root', handle);
        return handle;
    }
    async function restoreDirectory() {
        try {
            const handle = await idbGet(STORE_HANDLES, 'root');
            if (!handle) return null;
            if (handle.queryPermission) {
                let perm = await handle.queryPermission({ mode: 'read' });
                if (perm !== 'granted' && handle.requestPermission) {
                    perm = await handle.requestPermission({ mode: 'read' });
                }
                if (perm !== 'granted') return null;
            }
            return handle;
        } catch (e) { return null; }
    }
    async function clearLocalData() {
        try {
            await idbDel(STORE_HANDLES, 'root');
            await idbDel(STORE_LIBRARY, 'items');
        } catch (e) {}
    }

    async function listAllFiles(dirHandle, basePath, onProgress) {
        const results = [];
        let count = 0;
        async function walk(dir, pathPrefix) {
            for await (const [name, handle] of dir.entries()) {
                if (name.startsWith('.')) continue;
                const rel = pathPrefix ? pathPrefix + '/' + name : name;
                if (handle.kind === 'directory') {
                    await walk(handle, rel);
                } else {
                    results.push({ path: rel, name, handle, kind: 'file', parentPath: pathPrefix || '' });
                    count++;
                    if (onProgress && count % 50 === 0) onProgress({ scanned: count, phase: 'listing' });
                }
            }
        }
        await walk(dirHandle, basePath || '');
        if (onProgress) onProgress({ scanned: results.length, phase: 'listed' });
        return results;
    }

    function findSidecarImage(videoPath, videoBase, allFilesByDir) {
        const parent = videoPath.includes('/') ? videoPath.slice(0, videoPath.lastIndexOf('/')) : '';
        const siblings = allFilesByDir.get(parent) || [];
        const candidates = [
            videoBase + '.jpg', videoBase + '.jpeg', videoBase + '.png', videoBase + '.webp',
            videoBase + '-poster.jpg', videoBase + '-poster.png',
            videoBase + '-thumb.jpg', videoBase + '.poster.jpg'
        ];
        for (const c of candidates) {
            const hit = siblings.find(f => f.name.toLowerCase() === c.toLowerCase());
            if (hit) return hit;
        }
        for (const n of IMAGE_NAMES) {
            const hit = siblings.find(f =>
                f.name.toLowerCase() === n.toLowerCase() ||
                f.name.toLowerCase() === n.toLowerCase() + '.jpg' ||
                f.name.toLowerCase() === n.toLowerCase() + '.png'
            );
            if (hit && IMAGE_EXT.has(extOf(hit.name))) return hit;
        }
        return siblings.find(f => {
            const e = extOf(f.name);
            if (!IMAGE_EXT.has(e)) return false;
            const b = baseName(f.name).toLowerCase();
            return b === videoBase.toLowerCase() || b.startsWith(videoBase.toLowerCase() + '-');
        }) || null;
    }

    function findNfoFile(videoPath, videoBase, allFilesByDir) {
        const parent = videoPath.includes('/') ? videoPath.slice(0, videoPath.lastIndexOf('/')) : '';
        const siblings = allFilesByDir.get(parent) || [];
        const names = [videoBase + '.nfo', 'movie.nfo', 'tvshow.nfo', 'season.nfo', 'episode.nfo'];
        for (const n of names) {
            const hit = siblings.find(f => f.name.toLowerCase() === n.toLowerCase());
            if (hit) return hit;
        }
        return siblings.find(f => extOf(f.name) === 'nfo' && baseName(f.name).toLowerCase() === videoBase.toLowerCase()) || null;
    }

    function textOf(el, selectors) {
        if (!el) return '';
        for (const sel of selectors) {
            const node = el.querySelector(sel);
            if (node && node.textContent) return node.textContent.trim();
        }
        return '';
    }

    function parseNfoXml(xmlText) {
        const meta = { title: '', plot: '', year: '', runtime: 0, rating: 0, genres: [], actors: [], premiered: '', studio: '', tagline: '' };
        try {
            const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
            const root = doc.documentElement;
            if (!root || root.querySelector('parsererror')) return meta;
            meta.title = textOf(root, ['title', 'localtitle', 'originaltitle']) || '';
            meta.plot = textOf(root, ['plot', 'outline', 'description']) || '';
            meta.year = textOf(root, ['year']) || '';
            meta.premiered = textOf(root, ['premiered', 'aired', 'dateadded']) || '';
            meta.studio = textOf(root, ['studio', 'company']) || '';
            meta.tagline = textOf(root, ['tagline']) || '';
            const runtimeStr = textOf(root, ['runtime']);
            if (runtimeStr) meta.runtime = parseInt(runtimeStr, 10) || 0;
            const ratingStr = textOf(root, ['rating', 'rating > value', 'ratings > rating > value']);
            if (ratingStr) meta.rating = parseFloat(ratingStr) || 0;
            root.querySelectorAll('genre').forEach(g => {
                const t = (g.textContent || '').trim();
                if (t) meta.genres.push(t);
            });
            root.querySelectorAll('actor').forEach(a => {
                const name = textOf(a, ['name']);
                const role = textOf(a, ['role']);
                if (name) meta.actors.push({ Name: name, Role: role || '', Type: 'Actor' });
            });
        } catch (e) { console.warn('NFO parse error', e); }
        return meta;
    }

    async function readTextFile(fileHandle) {
        const file = await fileHandle.getFile();
        return file.text();
    }

    async function scanLibrary(dirHandle, onProgress) {
        const allFiles = await listAllFiles(dirHandle, '', onProgress);
        const byDir = new Map();
        for (const f of allFiles) {
            const key = f.parentPath || '';
            if (!byDir.has(key)) byDir.set(key, []);
            byDir.get(key).push(f);
        }
        const videos = allFiles.filter(f => VIDEO_EXT.has(extOf(f.name)));
        const items = [];
        let i = 0;
        for (const v of videos) {
            i++;
            if (onProgress && i % 10 === 0) onProgress({ scanned: i, total: videos.length, phase: 'parsing', current: v.name });
            const vBase = baseName(v.name);
            const id = simpleHash(v.path);
            let meta = { title: vBase, plot: '', year: '', runtime: 0, rating: 0, genres: [], actors: [], premiered: '', studio: '', tagline: '' };
            const nfo = findNfoFile(v.path, vBase, byDir);
            if (nfo) {
                try {
                    const xml = await readTextFile(nfo.handle);
                    const parsed = parseNfoXml(xml);
                    meta = { ...meta, ...parsed };
                    if (!meta.title) meta.title = vBase;
                } catch (e) {}
            }
            if (!meta.year) {
                const ym = vBase.match(/(19|20)\d{2}/);
                if (ym) meta.year = ym[0];
            }
            const img = findSidecarImage(v.path, vBase, byDir);
            items.push({
                Id: id,
                Name: meta.title || vBase,
                Overview: meta.plot || '',
                Path: v.path,
                ProductionYear: meta.year ? parseInt(meta.year, 10) : null,
                CommunityRating: meta.rating || null,
                RunTimeTicks: meta.runtime ? meta.runtime * 600000000 : null,
                Type: 'Movie',
                MediaType: 'Video',
                IsFolder: false,
                ImageTags: img ? { Primary: 'local' } : {},
                Tags: meta.genres || [],
                TagItems: (meta.genres || []).map(g => ({ Name: g })),
                People: meta.actors || [],
                Studios: meta.studio ? [{ Name: meta.studio }] : [],
                Taglines: meta.tagline ? [meta.tagline] : [],
                PremiereDate: meta.premiered || null,
                _local: true,
                _fileHandle: v.handle,
                _imageHandle: img ? img.handle : null,
                _relativePath: v.path,
                MediaSources: [{
                    Id: id, Path: v.path, Container: extOf(v.name), Protocol: 'File',
                    SupportsDirectPlay: true, SupportsDirectStream: true
                }]
            });
        }
        items.sort((a, b) => (a.Path || '').localeCompare(b.Path || '', undefined, { numeric: true }));
        try {
            const serializable = items.map(it => ({
                Id: it.Id, Name: it.Name, Overview: it.Overview, Path: it.Path,
                ProductionYear: it.ProductionYear, CommunityRating: it.CommunityRating,
                RunTimeTicks: it.RunTimeTicks, Type: it.Type, ImageTags: it.ImageTags,
                Tags: it.Tags, TagItems: it.TagItems, People: it.People,
                _local: true, _relativePath: it._relativePath
            }));
            await idbSet(STORE_LIBRARY, 'items', { updatedAt: Date.now(), items: serializable });
        } catch (e) { console.warn('cache library meta failed', e); }
        if (onProgress) onProgress({ scanned: items.length, total: items.length, phase: 'done' });
        return items;
    }

    async function createBlobUrl(fileHandle) {
        if (!fileHandle) return '';
        const file = await fileHandle.getFile();
        return URL.createObjectURL(file);
    }
    async function getLocalVideoUrl(item) {
        if (!item || !item._fileHandle) return '';
        return createBlobUrl(item._fileHandle);
    }
    async function getLocalImageUrl(item) {
        if (!item || !item._imageHandle) return '';
        return createBlobUrl(item._imageHandle);
    }

    async function reattachHandles(items, rootHandle) {
        if (!rootHandle || !items || !items.length) return items;
        const allFiles = await listAllFiles(rootHandle);
        const map = new Map(allFiles.map(f => [f.path, f]));
        for (const it of items) {
            const path = it._relativePath || it.Path;
            const f = map.get(path);
            if (f) { it._fileHandle = f.handle; it._local = true; }
            if (path) {
                const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
                const vBase = baseName(path.split('/').pop() || '');
                const byDir = new Map();
                for (const af of allFiles) {
                    const k = af.parentPath || '';
                    if (!byDir.has(k)) byDir.set(k, []);
                    byDir.get(k).push(af);
                }
                const img = findSidecarImage(path, vBase, byDir);
                if (img) {
                    it._imageHandle = img.handle;
                    it.ImageTags = it.ImageTags || {};
                    it.ImageTags.Primary = 'local';
                }
            }
        }
        return items;
    }

    window.EmbyXLocal = {
        isSupported, pickDirectory, restoreDirectory, clearLocalData,
        scanLibrary, createBlobUrl, getLocalVideoUrl, getLocalImageUrl, reattachHandles,
        openDB, idbGet, idbSet
    };
})(window);
