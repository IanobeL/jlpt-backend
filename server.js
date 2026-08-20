require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Kita siapkan variabel kosong untuk menampung client dan db nanti
let client;
let db;

// =========================================================================
// 🏷️ SISTEM KODE TOPIK (12 Rumpun Kanji Baku) — sumber kebenaran tunggal
// agar label bisa diganti nanti tanpa migrasi ulang seluruh dokumen soal.
// =========================================================================
const TOPIC_LABELS = {
  EXP: '経験＆会話',
  HLT: '健康＆運動',
  POL: '世界＆政治',
  WTH: '天気＆災害',
  TRV: '観光＆飲食',
  SCI: '科学＆学術',
  CUL: '文化＆言語',
  PSY: '心理＆意識',
  WRK: '仕事＆交通',
  EDU: '教育＆家庭',
  LIF: '趣味＆生活',
  TEC: '技術＆報道',
  BP1: '文法一週目',
  BP2: '文法二週目',
  BP3: '文法三週目',
  BP4: '文法四週目',
  BP5: '文法五週目',
  BP6: '文法六週目'
};
const TOPIC_MAP_TO_CODE = Object.fromEntries(
  Object.entries(TOPIC_LABELS).map(([code, label]) => [label, code])
);

// Melengkapi topic/topicCode sebuah objek soal secara deterministik (bukan AI)
function resolveTopicFields(q) {
  let topic = q.topic;
  let topicCode = q.topicCode;
  if (topicCode && !topic) {
    topic = TOPIC_LABELS[topicCode] || '趣味＆生活';
  } else if (topic && !topicCode) {
    topicCode = TOPIC_MAP_TO_CODE[topic] || 'LIF';
  } else if (!topic && !topicCode) {
    topic = '趣味＆生活';
    topicCode = 'LIF';
  }
  return { topic, topicCode };
}

async function startServer() {
  try {
    // Membaca URI tepat di dalam fungsi async agar tidak 'undefined' di Railway
    const uri = process.env.MONGODB_URI;
    
    if (!uri) {
      throw new Error("Gagal membaca MONGODB_URI dari environment Railway!");
    }

    client = new MongoClient(uri);
    
    // Mengetuk langsung ke gerbang database
    await client.connect();
    db = client.db('kebun_jlpt');
    console.log('✓ Hubungan Aman: Server Lokal sukses terhubung ke MongoDB Atlas Cloud!');
    
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, '0.0.0.0', () => console.log(`✓ Pak Kurir API aktif standby di port ${PORT}`));
  } catch (error) {
    console.error('⚠️ Gagal menyalakan server atau koneksi database:', error);
  }
}

// --- Rute Gerbang Data (API) ---

// Config disimpan per mode: 'test' -> 'active_rules' (CONFIG-45, 60 menit/50 soal),
// 'quiz' -> 'quiz_rules' (panel baru, 30 menit/25 soal). Default ke 'active_rules'
// jika ?mode= tidak dikirim, supaya pemanggil lama (mode test) tetap bekerja tanpa ubahan.
function resolveConfigType(req) {
  return req.query.mode === 'quiz' ? 'quiz_rules' : 'active_rules';
}

app.get('/api/exam-config', async (req, res) => {
  try {
    const configType = resolveConfigType(req);
    const currentConfig = await db.collection('settings').findOne({ type: configType });
    res.json(currentConfig || { success: false, msg: 'Gunakan konfigurasi standar klien.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-config', async (req, res) => {
  try {
    const configType = resolveConfigType(req);
    const newConfig = req.body;
    await db.collection('settings').updateOne(
      { type: configType },
      { $set: { type: configType, updated_at: new Date(), rules: newConfig } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Aturan baru berhasil dikunci di MongoDB!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Versi ringan config (hanya timestamp) — dipakai frontend App 1 untuk cek
// "apakah config berubah?" tanpa perlu menarik seluruh dokumen rules tiap load.
app.get('/api/exam-config-version', async (req, res) => {
  try {
    const configType = resolveConfigType(req);
    const currentConfig = await db.collection('settings').findOne(
      { type: configType },
      { projection: { updated_at: 1 } }
    );
    const version = currentConfig?.updated_at ? new Date(currentConfig.updated_at).getTime() : 0;
    res.json({ success: true, version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 🔘 FILTER TOPIK ON/OFF: satu pengaturan bersama (bukan per-mode) yang
// menentukan topic mana saja yang boleh muncul di Test Mode maupun Quiz Mode.
// Default semua topic aktif jika belum pernah disimpan (kompatibel dengan
// perilaku lama sebelum fitur ini ada).
// =========================================================================
app.get('/api/topic-filter', async (req, res) => {
  try {
    const doc = await db.collection('settings').findOne({ type: 'topic_filter' });
    const enabledTopics = doc?.enabledTopics || Object.fromEntries(Object.keys(TOPIC_LABELS).map(code => [code, true]));
    res.json({ success: true, enabledTopics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-topic-filter', async (req, res) => {
  try {
    const { enabledTopics } = req.body;
    if (!enabledTopics || typeof enabledTopics !== 'object') {
      return res.status(400).json({ error: "Field 'enabledTopics' harus berupa objek." });
    }
    await db.collection('settings').updateOne(
      { type: 'topic_filter' },
      { $set: { type: 'topic_filter', updated_at: new Date(), enabledTopics } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Filter topik berhasil disimpan di MongoDB!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 📦 MODE PAKET SOAL (Package Mode): daftar paket (read-only dari sisi App 1,
// paket sendiri dikelola/di-rename lewat App 2/CMS) + paket mana yang sedang
// AKTIF (hanya boleh 1 pada satu waktu). Saat aktif, App 1 melewati filter
// topic & proporsi soal CONFIG-45/50 — dan langsung memakai soal yang sudah
// ditandai packageId itu, dengan bobot poin per subkategori dari
// package.subCategoryWeights (diatur di App 2).
// =========================================================================
app.get('/api/packages', async (req, res) => {
  try {
    const pkgs = await db.collection('packages').find({}).sort({ createdAt: -1 }).toArray();

    // Union dengan packageId yang benar-benar dipakai di questions_bank tapi belum
    // pernah "resmi" didaftarkan di koleksi packages (mis. lewat Bulk Import App 2
    // yang packageId-nya sudah menempel langsung di JSON, tanpa lewat modal + 新規追加).
    // Tanpa ini, paket seperti itu tidak akan pernah muncul di dropdown Mode Paket App 1.
    const knownNames = new Set(pkgs.map(p => p.name));
    const distinctPackageIds = await db.collection('questions_bank').distinct('packageId');
    distinctPackageIds.forEach(pid => {
      if (pid && !knownNames.has(pid)) {
        pkgs.push({ name: pid, subCategoryWeights: {}, isAutoDetected: true });
        knownNames.add(pid);
      }
    });

    res.json({ success: true, packages: pkgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/active-package', async (req, res) => {
  try {
    const doc = await db.collection('settings').findOne({ type: 'active_package' });
    res.json({ success: true, packageId: doc?.packageId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/set-active-package', async (req, res) => {
  try {
    const { packageId } = req.body;
    if (packageId !== null && typeof packageId !== 'string') {
      return res.status(400).json({ error: "Field 'packageId' harus berupa string nama paket, atau null untuk menonaktifkan." });
    }
    await db.collection('settings').updateOne(
      { type: 'active_package' },
      { $set: { type: 'active_package', updated_at: new Date(), packageId: packageId || null } },
      { upsert: true }
    );
    res.json({ success: true, packageId: packageId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 🎛️ RUTE SINKRONISASI OPTIMIZED: PENCARIAN FLEKSIBEL & FILTER SUB-SOAL
// =========================================================================
app.get('/api/get-exam-questions', async (req, res) => {
  try {
    const { level, subCategory } = req.query;

    if (!level) {
      return res.status(400).json({ error: "Parameter 'level' wajib disertakan (contoh: ?level=N3)" });
    }

    // Ubah parameter level menjadi huruf kecil agar pas dengan skema MongoDB Atlas
    const targetLevel = level.toLowerCase();

    // Bangun fondasi kueri dasar berdasarkan level ujian
    let queryFilter = { level: targetLevel };

    // 🚀 LOGIKA CARA 1: Jika frontend meminta subkategori spesifik, kunci pencariannya langsung di DB
    // CATATAN: subCategory tersimpan sebagai STRING murni di MongoDB (mis. "2"), bukan angka —
    // jadi kita cocokkan sebagai string. Field lama (sub/subCategoryCode) tetap didukung untuk jaga-jaga.
    if (subCategory) {
      const subCode = Number(subCategory);
      queryFilter.$or = [
        { subCategory: String(subCategory) },
        { subCategoryCode: isNaN(subCode) ? subCategory : subCode },
        { sub: isNaN(subCode) ? subCategory : subCode }
      ];
    }

    // Ambil data dari MongoDB berdasarkan kueri filter di atas
    const questionsPool = await db.collection('questions_bank')
      .find(queryFilter)
      .toArray();

    res.json(questionsPool);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 🎧 PROXY MEDIA GOOGLE DRIVE (gambar & audio soal) — DENGAN CACHE 1 JAM
// Hotlink langsung ke drive.google.com/docs.google.com terbukti tidak reliable
// untuk audio (Google mengembalikan halaman HTML peringatan virus-scan, bukan
// file mentah). Endpoint ini fetch file-nya SENDIRI lewat Drive API resmi
// (files.get?alt=media) memakai API key di server — key TIDAK PERNAH terkirim
// ke browser murid.
//
// Google Drive akan memblokir sementara (403) file yang diakses berkali-kali
// dalam waktu singkat ("too many users have viewed or downloaded this file").
// Supaya Drive cuma di-hit SEKALI per file per jam (berapapun banyaknya murid
// yang minta file yang sama), file lengkap di-buffer di memori server begitu
// pertama kali diambil, lalu request berikutnya (termasuk Range request untuk
// seek) dilayani langsung dari cache tanpa pernah menyentuh Drive lagi sampai
// cache itu kedaluwarsa.
// =========================================================================
const DRIVE_MEDIA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam
const DRIVE_MEDIA_CACHE_MAX_BYTES = 150 * 1024 * 1024; // 150MB — batas total RAM yang boleh dipakai cache ini
const driveMediaCache = new Map(); // fileId -> { buffer, contentType, cachedAt, size }
const driveMediaFetchInFlight = new Map(); // fileId -> Promise<{buffer, contentType}>
let driveMediaCacheBytes = 0;

function evictDriveMediaCacheIfNeeded(incomingSize) {
  if (driveMediaCacheBytes + incomingSize <= DRIVE_MEDIA_CACHE_MAX_BYTES) return;

  // Buang entri TERLAMA (cachedAt paling kecil) dulu sampai muat, mirip LRU sederhana
  const entries = Array.from(driveMediaCache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  for (const [key, value] of entries) {
    if (driveMediaCacheBytes + incomingSize <= DRIVE_MEDIA_CACHE_MAX_BYTES) break;
    driveMediaCache.delete(key);
    driveMediaCacheBytes -= value.size;
  }
}

async function getDriveMediaBuffer(fileId, apiKey) {
  const cached = driveMediaCache.get(fileId);
  if (cached && Date.now() - cached.cachedAt < DRIVE_MEDIA_CACHE_TTL_MS) {
    return cached;
  }

  if (driveMediaFetchInFlight.has(fileId)) {
    return driveMediaFetchInFlight.get(fileId);
  }

  const fetchPromise = (async () => {
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const driveRes = await fetch(driveUrl); // TANPA Range — selalu ambil file utuh sekali, biar bisa di-cache & di-slice sendiri

    if (!driveRes.ok) {
      const errText = await driveRes.text();
      const err = new Error(errText || `Drive respond ${driveRes.status}`);
      err.status = driveRes.status;
      throw err;
    }

    const buffer = Buffer.from(await driveRes.arrayBuffer());
    const contentType = driveRes.headers.get('content-type') || 'application/octet-stream';

    // Kalau fileId ini sudah pernah di-cache sebelumnya (refresh), lepas dulu ukuran lamanya
    const previous = driveMediaCache.get(fileId);
    if (previous) driveMediaCacheBytes -= previous.size;

    evictDriveMediaCacheIfNeeded(buffer.length);

    const entry = { buffer, contentType, cachedAt: Date.now(), size: buffer.length };
    driveMediaCache.set(fileId, entry);
    driveMediaCacheBytes += buffer.length;
    return entry;
  })();

  driveMediaFetchInFlight.set(fileId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    driveMediaFetchInFlight.delete(fileId);
  }
}

app.get('/api/drive-media/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GOOGLE_DRIVE_API_KEY belum diset di server.' });
    }

    let entry;
    try {
      entry = await getDriveMediaBuffer(fileId, apiKey);
    } catch (driveErr) {
      console.error('Drive media proxy failed:', driveErr.status, driveErr.message);
      return res.status(driveErr.status || 502).json({ error: 'Gagal mengambil media dari Google Drive.' });
    }

    const { buffer, contentType } = entry;
    const totalSize = buffer.length;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = match && match[1] ? parseInt(match[1], 10) : 0;
      let end = match && match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end > totalSize - 1) end = totalSize - 1;

      if (start > end || start >= totalSize) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.send(buffer.subarray(start, end + 1));
    }

    res.status(200);
    res.setHeader('Content-Length', totalSize);
    res.send(buffer);
  } catch (err) {
    console.error('Drive media proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 🚀 ENDPOINT RIWAYAT MAHASISWA (Mencegah Error 404 di Railway)
// =========================================================================

// 1. Endpoint POST untuk menyimpan data riwayat baru dari murid
//    Field "mode" ('test' | 'quiz') membedakan riwayat Mode Test dan Mode Quiz.
//    Jika frontend lama belum mengirim mode, default ke 'test' agar data lama tetap konsisten.
app.post('/api/save-history', async (req, res) => {
  try {
    const record = req.body;

    if (record.mode !== 'quiz' && record.mode !== 'test') {
      record.mode = 'test';
    }

    // Memberikan stempel waktu server (timestamp) otomatis saat data masuk
    record.created_at = new Date();

    // Menyisipkan record mentah ke dalam koleksi 'histories' di MongoDB Cloud
    const result = await db.collection('histories').insertOne(record);

    res.status(201).json({
      success: true,
      message: 'Riwayat ujian mahasiswa sukses tercatat di MongoDB Atlas!',
      insertedId: result.insertedId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Endpoint GET untuk menarik data riwayat murid untuk Portal Guru
//    Mendukung ?paginated=true&limit=20&skip=N agar tidak menarik seluruh koleksi tiap kali dibuka.
//    Mendukung ?mode=test|quiz untuk memisahkan riwayat Test Mode dan Quiz Mode secara ter-scope
//    (tanpa filter mode, tetap mengembalikan semua riwayat seperti sebelumnya).
app.get('/api/get-history', async (req, res) => {
  try {
    const { paginated, limit, skip, mode } = req.query;
    const filter = {};
    if (mode === 'test' || mode === 'quiz') {
      filter.mode = mode;
    }

    // 'questions' berisi snapshot lengkap tiap soal (teks, opsi, jawaban murid) —
    // sengaja DIKECUALIKAN dari list ringkas ini agar loading Portal Guru tetap
    // cepat. Detail lengkap satu sesi ambil lewat GET /api/get-history/:id.
    const listProjection = { projection: { questions: 0 } };

    if (paginated === 'true') {
      const limitNum = Math.min(Number(limit) || 20, 100);
      const skipNum = Number(skip) || 0;
      const [historyLogsSet, total] = await Promise.all([
        db.collection('histories').find(filter, listProjection).sort({ _id: -1 }).skip(skipNum).limit(limitNum).toArray(),
        db.collection('histories').countDocuments(filter)
      ]);
      return res.json({
        success: true,
        data: historyLogsSet,
        hasMore: skipNum + historyLogsSet.length < total,
        total
      });
    }

    // Kompatibilitas lama: tanpa ?paginated=true, tetap kembalikan array mentah.
    const historyLogsSet = await db.collection('histories').find(filter, listProjection).sort({ _id: -1 }).toArray();
    res.json(historyLogsSet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Ambil SATU sesi riwayat lengkap dengan field 'questions' (snapshot soal +
//    jawaban murid) untuk fitur "review jawaban" di Portal Guru — dipanggil
//    hanya saat guru membuka detail satu sesi, bukan saat memuat daftar.
app.get('/api/get-history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const record = await db.collection('histories').findOne({ _id: new ObjectId(id) });
    if (!record) {
      return res.status(404).json({ success: false, error: 'Sesi riwayat tidak ditemukan.' });
    }
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 📝 CRUD SOAL: Rute nyata untuk App Kedua (JLPT 問題作成 CMS)
// Sebelumnya CMS hanya menyimpan ke array in-memory (hilang saat restart).
// Rute di bawah ini menulis ke koleksi 'questions_bank' yang sesungguhnya.
// =========================================================================

// Tambah satu soal baru
app.post('/api/questions', async (req, res) => {
  try {
    const { topic, topicCode } = resolveTopicFields(req.body);
    const newQuestion = { ...req.body, topic, topicCode };
    const result = await db.collection('questions_bank').insertOne(newQuestion);
    res.status(201).json({ success: true, question: { ...newQuestion, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tambah banyak soal sekaligus (dipakai tombol "MongoDBへ一括登録 / Publish to Production")
app.post('/api/questions/bulk', async (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'questions' harus berupa array dan tidak boleh kosong." });
    }
    const result = await insertQuestionsBulk(questions);
    res.status(201).json({
      success: true,
      insertedCount: result.insertedCount,
      message: `Berhasil mendaftarkan ${result.insertedCount} soal ke MongoDB Atlas!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update satu soal (dipakai form edit di CMS)
app.put('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const update = { ...req.body };
    delete update._id; // _id tidak boleh ikut di-set ulang

    if (update.topic || update.topicCode) {
      const { topic, topicCode } = resolveTopicFields(update);
      update.topic = topic;
      update.topicCode = topicCode;
    }

    const result = await db.collection('questions_bank').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'Soal tidak ditemukan.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hapus satu soal
app.delete('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('questions_bank').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Soal tidak ditemukan.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 🗂️ RUTE CMS APP ② (JLPT 問題作成): Question Manager & パッケージ管理
// App ② sebelumnya memakai API tiruan (mock/seed) di server-nya sendiri, jadi
// isinya tidak pernah nyambung ke MongoDB yang sama dengan App ①. Rute di bawah
// ini melayani kontrak yang MEMANG SUDAH DIPAKAI frontend App ② apa adanya,
// supaya App ② cukup mem-proxy /api/* ke sini tanpa dirombak besar-besaran.
// =========================================================================

// Ubah array id string dari frontend menjadi ObjectId, id yang tidak valid dibuang
// (daripada melempar error dan menggagalkan seluruh operasi batch).
function toObjectIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
}

// Daftar nama package saja (frontend App ② merender list ini sebagai string biasa).
// Ikut menyertakan packageId yang cuma menempel di questions_bank tapi belum
// terdaftar resmi di koleksi packages — logika union yang sama seperti GET /api/packages.
async function listPackageNames() {
  const pkgs = await db.collection('packages').find({}).sort({ createdAt: -1 }).toArray();
  const names = pkgs.map(p => p.name);
  const known = new Set(names);
  const distinctPackageIds = await db.collection('questions_bank').distinct('packageId');
  distinctPackageIds.forEach(pid => {
    if (pid && !known.has(pid)) {
      names.push(pid);
      known.add(pid);
    }
  });
  return names;
}

// Insert batch soal — dipakai bersama oleh /api/questions/bulk dan /api/publish
async function insertQuestionsBulk(questions) {
  const processed = questions.map(q => {
    const { topic, topicCode } = resolveTopicFields(q);
    return { ...q, topic, topicCode, isReleased: q.isReleased ?? true };
  });
  return db.collection('questions_bank').insertMany(processed);
}

// Cari soal untuk Question Manager. Semua filter opsional kecuali tidak ada yang wajib —
// tanpa filter sama sekali berarti "semua soal". Mengembalikan array mentah karena
// frontend App ② langsung memakai hasilnya sebagai array (bukan objek berpembungkus).
app.get('/api/questions/browse', async (req, res) => {
  try {
    const { level, subCategory, topicCode, packageId } = req.query;
    const queryFilter = {};
    if (level) queryFilter.level = level.toLowerCase();
    if (subCategory) queryFilter.subCategory = String(subCategory);
    if (topicCode) queryFilter.topicCode = topicCode;
    if (packageId) queryFilter.packageId = packageId;

    const questions = await db.collection('questions_bank').find(queryFilter).toArray();
    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tempelkan (atau lepaskan) beberapa soal sekaligus ke sebuah package
app.post('/api/questions/assign-package', async (req, res) => {
  try {
    const { ids, packageId, unassign } = req.body;
    const objectIds = toObjectIds(ids);
    if (objectIds.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'ids' harus berisi minimal satu _id soal yang valid." });
    }
    if (!unassign && !packageId) {
      return res.status(400).json({ success: false, error: "Field 'packageId' wajib diisi kecuali unassign=true." });
    }

    const result = await db.collection('questions_bank').updateMany(
      { _id: { $in: objectIds } },
      { $set: { packageId: unassign ? '' : packageId } }
    );
    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hapus beberapa soal sekaligus (tombol "選択した問題を削除")
app.post('/api/questions/bulk-delete', async (req, res) => {
  try {
    const objectIds = toObjectIds(req.body.ids);
    if (objectIds.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'ids' harus berisi minimal satu _id soal yang valid." });
    }
    const result = await db.collection('questions_bank').deleteMany({ _id: { $in: objectIds } });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ubah field yang sama pada beberapa soal sekaligus (mis. ganti topic/level massal)
app.post('/api/questions/bulk-update-fields', async (req, res) => {
  try {
    const { ids, fields } = req.body;
    const objectIds = toObjectIds(ids);
    if (objectIds.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'ids' harus berisi minimal satu _id soal yang valid." });
    }
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, error: "Field 'fields' harus berupa objek dan tidak boleh kosong." });
    }

    const update = { ...fields };
    delete update._id;
    if (update.topic || update.topicCode) {
      const { topic, topicCode } = resolveTopicFields(update);
      update.topic = topic;
      update.topicCode = topicCode;
    }

    const result = await db.collection('questions_bank').updateMany(
      { _id: { $in: objectIds } },
      { $set: update }
    );
    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daftarkan batch soal hasil AI Engine ke produksi — nama rute versi App ②,
// perilakunya identik dengan /api/questions/bulk
app.post('/api/publish', async (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'questions' harus berupa array dan tidak boleh kosong." });
    }
    const result = await insertQuestionsBulk(questions);
    res.status(201).json({
      success: true,
      insertedCount: result.insertedCount,
      message: `Berhasil mendaftarkan ${result.insertedCount} soal ke MongoDB Atlas!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Buat package baru
app.post('/api/packages', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: "Field 'name' tidak boleh kosong." });
    }
    const existing = await db.collection('packages').findOne({ name });
    if (existing) {
      return res.status(409).json({ success: false, error: `Package "${name}" sudah ada.` });
    }
    await db.collection('packages').insertOne({ name, createdAt: new Date() });
    res.status(201).json({ success: true, packages: await listPackageNames() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ganti nama package. Nama package dipakai sebagai packageId di questions_bank dan
// di settings.active_package, jadi rename HARUS ikut memperbarui keduanya — kalau tidak,
// soal-soalnya jadi yatim (menunjuk nama package yang sudah tidak ada).
app.put('/api/packages/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const newName = (req.body.newName || '').trim();
    if (!newName) {
      return res.status(400).json({ success: false, error: "Field 'newName' tidak boleh kosong." });
    }
    if (newName === oldName) {
      return res.json({ success: true, newName });
    }
    const duplicate = await db.collection('packages').findOne({ name: newName });
    if (duplicate) {
      return res.status(409).json({ success: false, error: `Package "${newName}" sudah ada.` });
    }

    await db.collection('packages').updateOne({ name: oldName }, { $set: { name: newName } });
    await db.collection('questions_bank').updateMany({ packageId: oldName }, { $set: { packageId: newName } });
    await db.collection('settings').updateOne(
      { type: 'active_package', packageId: oldName },
      { $set: { packageId: newName, updated_at: new Date() } }
    );

    res.json({ success: true, newName });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hapus package. Soalnya TIDAK ikut dihapus — cuma dilepas dari package (packageId
// dikosongkan), supaya bank soal tidak ikut hilang gara-gara paketnya dibubarkan.
app.delete('/api/packages/:name', async (req, res) => {
  try {
    const name = req.params.name;
    await db.collection('packages').deleteOne({ name });
    const unassigned = await db.collection('questions_bank').updateMany(
      { packageId: name },
      { $set: { packageId: '' } }
    );
    await db.collection('settings').updateOne(
      { type: 'active_package', packageId: name },
      { $set: { packageId: null, updated_at: new Date() } }
    );

    res.json({ success: true, unassignedCount: unassigned.modifiedCount, packages: await listPackageNames() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 🔄 MIGRASI FORMAT LAMA -> BARU untuk soal yang SUDAH ADA di database
// Alur: (1) admin scan dokumen lama by level/subCategory, (2) CMS mengonversi
// lewat AI Engine yang sudah ada, (3) commit di sini meng-UPDATE dokumen ASLI
// (matching _id yang sama) — bukan insert baru/duplikat.
// =========================================================================

// 1. Pindai dokumen lama yang belum punya field topicCode, dibatasi level/subCategory
app.get('/api/questions/legacy-scan', async (req, res) => {
  try {
    const { level, subCategory } = req.query;
    if (!level) {
      return res.status(400).json({ error: "Parameter 'level' wajib disertakan (contoh: ?level=n3)" });
    }
    const queryFilter = {
      level: level.toLowerCase(),
      topicCode: { $exists: false }
    };
    if (subCategory) {
      queryFilter.subCategory = String(subCategory);
    }
    const legacyQuestions = await db.collection('questions_bank').find(queryFilter).toArray();
    res.json({ success: true, count: legacyQuestions.length, questions: legacyQuestions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Terapkan hasil migrasi yang sudah disetujui admin: UPDATE dokumen asli by _id
app.post('/api/migrate-legacy/commit', async (req, res) => {
  try {
    const { migratedQuestions } = req.body;
    if (!Array.isArray(migratedQuestions) || migratedQuestions.length === 0) {
      return res.status(400).json({ success: false, error: "Field 'migratedQuestions' harus berupa array dan tidak boleh kosong." });
    }

    const results = [];
    for (const item of migratedQuestions) {
      const { originalId, ...fields } = item;
      if (!originalId) {
        results.push({ originalId: null, success: false, error: 'originalId tidak disertakan.' });
        continue;
      }
      delete fields._id;
      const { topic, topicCode } = resolveTopicFields(fields);
      fields.topic = topic;
      fields.topicCode = topicCode;

      const result = await db.collection('questions_bank').updateOne(
        { _id: new ObjectId(originalId) },
        { $set: fields }
      );
      results.push({ originalId, success: result.matchedCount > 0 });
    }

    const successCount = results.filter(r => r.success).length;
    res.json({
      success: true,
      updatedCount: successCount,
      message: `Berhasil migrasi ${successCount}/${migratedQuestions.length} soal (update dokumen asli, bukan duplikat).`,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

startServer();
