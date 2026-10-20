require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// request logger
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const CARD_PRICE = 100;
const PHONE_RE = /^0\d{9}$/;

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function adminOnly(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- STATIC PAGES (no public folder needed) ----------
app.get(['/', '/player.html'], (req, res) =>
  res.sendFile(path.join(__dirname, 'player.html'))
);
app.get('/admin.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'admin.html'))
);

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- PLAYER ROUTES ----------

app.post('/api/player/login', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').replace(/\s+/g, '');

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Phone must look like 09XXXXXXXX' });
  }

  const { data: existing, error: findErr } = await supabase
    .from('users').select('*').eq('phone', phone).maybeSingle();
  if (findErr) throw findErr;

  let user = existing;
  if (!user) {
    const { data: created, error } = await supabase
      .from('users').insert({ name, phone, balance: 0 }).select().single();
    if (error) throw error;
    user = created;
  }

  res.json(user);
}));

app.get('/api/player/data/:user_id', wrap(async (req, res) => {
  const { data, error } = await supabase
    .from('users').select('id, name, balance')
    .eq('id', req.params.user_id).maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
}));

app.post('/api/player/deposit', wrap(async (req, res) => {
  const user_id = Number(req.body.user_id);
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const { data: user } = await supabase
    .from('users').select('id').eq('id', user_id).maybeSingle();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { error } = await supabase
    .from('transactions')
    .insert({ user_id, type: 'deposit', amount, status: 'pending' });
  if (error) throw error;

  res.json({ message: 'Deposit request sent. Waiting for admin approval.' });
}));

app.post('/api/player/withdraw', wrap(async (req, res) => {
  const user_id = Number(req.body.user_id);
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const { data, error } = await supabase.rpc('request_withdrawal', {
    p_user_id: user_id,
    p_amount: amount
  });
  if (error) return res.status(400).json({ error: error.message });

  res.json({
    message: 'Withdrawal requested. Admin will process it soon.',
    new_balance: data.new_balance
  });
}));

app.post('/api/player/play', wrap(async (req, res) => {
  const user_id = Number(req.body.user_id);
  const card_number = Number(req.body.card_number);

  const { data, error } = await supabase.rpc('place_ticket', {
    p_user_id: user_id,
    p_card_number: card_number
  });
  if (error) return res.status(400).json({ error: error.message });

  res.json({
    message: `You joined round #${data.round_id} with card ${data.card_number}.`,
    round_id: data.round_id,
    card_number: data.card_number,
    new_balance: data.new_balance
  });
}));

app.get('/api/player/round', wrap(async (req, res) => {
  const { data: round, error: rErr } = await supabase
    .from('rounds').select('id, status, created_at')
    .eq('status', 'active').maybeSingle();
  if (rErr) throw rErr;
  if (!round) return res.json({ round: null, taken: [] });

  const { data: tickets, error } = await supabase
    .from('tickets').select('card_number').eq('round_id', round.id);
  if (error) throw error;

  res.json({ round, taken: (tickets || []).map(t => t.card_number) });
}));

app.get('/api/player/history/:user_id', wrap(async (req, res) => {
  const user_id = req.params.user_id;

  const [tx, tickets] = await Promise.all([
    supabase.from('transactions')
      .select('id, type, amount, status, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('tickets')
      .select('card_number, created_at, rounds (id, status, draw_1, draw_2, draw_3)')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  if (tx.error) throw tx.error;
  if (tickets.error) throw tickets.error;

  res.json({ transactions: tx.data, tickets: tickets.data });
}));

// ---------- ADMIN ROUTES ----------

app.get('/api/admin/transactions', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, type, amount, status, created_at, users (name, phone)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/transaction/:id', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase.rpc('resolve_transaction', {
    p_tx_id: Number(req.params.id),
    p_action: String(req.body.action || '')
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: `Transaction ${data.status}`, ...data });
}));

app.get('/api/admin/players', adminOnly, wrap(async (req, res) => {
  const { data: round, error: rErr } = await supabase
    .from('rounds').select('id').eq('status', 'active').maybeSingle();
  if (rErr) throw rErr;
  if (!round) return res.json({ round: null, players: [] });

  const { data, error } = await supabase
    .from('tickets')
    .select('card_number, users (name, phone)')
    .eq('round_id', round.id)
    .order('card_number', { ascending: true });
  if (error) throw error;

  res.json({ round, players: data });
}));

app.post('/api/admin/draw', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase.rpc('finish_round');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.post('/api/admin/new-round', adminOnly, wrap(async (req, res) => {
  const { data: existing } = await supabase
    .from('rounds').select('id').eq('status', 'active').maybeSingle();
  if (existing) return res.status(400).json({ error: 'A round is already active' });

  const { data, error } = await supabase
    .from('rounds').insert({ status: 'active' }).select().single();
  if (error) throw error;

  res.json({ message: 'New round created.', round: data });
}));

// ---------- 404 ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: `No API route for ${req.method} ${req.path}`
    });
  }
  res.status(404).type('html').send(`
    <h1>404 — ${req.path}</h1>
    <p>Try <a href="/player.html">/player.html</a> or
       <a href="/admin.html">/admin.html</a>.</p>
  `);
});

// ---------- ERROR HANDLER ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dot Bingo server running on port ${PORT}`));
