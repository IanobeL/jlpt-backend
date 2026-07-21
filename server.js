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
  TEC: '技術＆報道'
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

app.get('/api/exam-config', async (req, res) => {
  try {
    const currentConfig = await db.collection('settings').findOne({ type: 'active_rules' });
    res.json(currentConfig || { success: false, msg: 'Gunakan konfigurasi standar klien.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-config', async (req, res) => {
  try {
    const newConfig = req.body;
    await db.collection('settings').updateOne(
      { type: 'active_rules' },
      { $set: { type: 'active_rules', updated_at: new Date(), rules: newConfig } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Aturan baru berhasil dikunci di MongoDB!' });
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
// 🚀 ENDPOINT RIWAYAT MAHASISWA (Mencegah Error 404 di Railway)
// =========================================================================

// 1. Endpoint POST untuk menyimpan data riwayat baru dari murid
app.post('/api/save-history', async (req, res) => {
  try {
    const record = req.body;
    
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
app.get('/api/get-history', async (req, res) => {
  try {
    const { paginated, limit, skip } = req.query;
    let cursor = db.collection('histories').find({}).sort({ _id: -1 });

    if (paginated === 'true') {
      const limitNum = Math.min(Number(limit) || 20, 100);
      const skipNum = Number(skip) || 0;
      cursor = cursor.skip(skipNum).limit(limitNum);
    }

    const historyLogsSet = await cursor.toArray();
    res.json(historyLogsSet);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const processed = questions.map(q => {
      const { topic, topicCode } = resolveTopicFields(q);
      return { ...q, topic, topicCode, isReleased: q.isReleased ?? true };
    });
    const result = await db.collection('questions_bank').insertMany(processed);
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
