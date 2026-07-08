const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI; 
const client = new MongoClient(uri);
let db;

async function startServer() {
  try {
    // Mengetuk langsung ke gerbang database
    await client.connect();
    db = client.db('kebun_jlpt');
    console.log('✓ Hubungan Aman: Server Lokal sukses terhubung ke MongoDB Atlas Cloud!');
    
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`✓ Pak Kurir API aktif standby di port ${PORT}`));
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

app.get('/api/get-exam-questions', async (req, res) => {
  try {
    const levelTarget = req.query.level;
    const activeRulesDoc = await db.collection('settings').findOne({ type: 'active_rules' });
    
    if (!activeRulesDoc) {
      return res.status(404).json({ error: "Aturan kustom belum diset di panel staff." });
    }

    const rules = activeRulesDoc.rules;
    let finalExamQuestionsSet = [];

    for (const subKey of Object.keys(rules)) {
      const requiredCount = rules[subKey].count;
      if (requiredCount > 0) {
        const sampleQuestions = await db.collection('questions_bank').aggregate([
          { $match: { level: levelTarget, subCategory: subKey } },
          { $sample: { size: requiredCount } }
        ]).toArray();
        
        finalExamQuestionsSet.push(...sampleQuestions);
      }
    }
    res.json(finalExamQuestionsSet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

startServer();
