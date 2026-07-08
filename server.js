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
// RUTE SINKRONISASI BARU: AMBIL 45 SOAL ACAK BERDASARKAN LEVEL
// =========================================================================
app.get('/api/get-exam-questions', async (req, res) => {
  try {
    const { level } = req.query;

    if (!level) {
      return res.status(400).json({ error: "Parameter 'level' wajib disertakan (contoh: ?level=N3)" });
    }

    // Ubah parameter (misal dari 'N3') menjadi huruf kecil ('n3') agar cocok dengan MongoDB Atlas
    const targetLevel = level.toLowerCase();

    // Ambil 45 soal secara acak sekaligus memanfaatkan indeks gabungan level & subCategory
    const finalExamQuestionsSet = await db.collection('questions_bank').aggregate([
      { 
        $match: { level: targetLevel } 
      },
      { 
        $sample: { size: 45 } 
      }
    ]).toArray();

    res.json(finalExamQuestionsSet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

startServer();
