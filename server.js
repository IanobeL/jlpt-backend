const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Kita siapkan variabel kosong untuk menampung client dan db nanti
let client;
let db;

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
    if (subCategory) {
      const subCode = Number(subCategory);
      if (!isNaN(subCode)) {
        // Mendukung pencarian fleksibel untuk field 'subCategoryCode', 'sub', maupun 'subCategory'
        queryFilter.$or = [
          { subCategoryCode: subCode },
          { sub: subCode },
          { subCategory: subCode }
        ];
      }
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

// 2. Endpoint GET untuk menarik data riwayat seluruh murid untuk Portal Guru
app.get('/api/get-history', async (req, res) => {
  try {
    // Menarik seluruh riwayat dan mengurutkannya secara terbalik (descending)
    // Berdasarkan id dokumen terbaru agar hasil tes paling baru muncul paling atas di tabel
    const fullHistoryLogsSet = await db.collection('histories')
      .find({})
      .sort({ _id: -1 })
      .toArray();

    res.json(fullHistoryLogsSet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

startServer();
