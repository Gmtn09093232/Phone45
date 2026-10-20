require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const CARD_PRICE = 100;
const PHONE_RE = /^(?:\+251|251|0)9\d{8}$/; 

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function adminOnly(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get(['/', '/player', '/player.html'], (req, res) => res.sendFile(path.join(__dirname, 'player.html')));
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- PLAYER ROUTES ----------
app.post('/api/player/login', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Invalid phone format.' });

  const { data: existing, error: findErr } = await supabase.from('users').select('*').eq('phone', phone).maybeSingle();
  if (findErr) throw findErr;

  let user = existing;
  if (!user) {
    const { data: created, error } = await supabase.from('users').insert({ name, phone, balance: 0 }).select().single();
    if (error) throw error;
    user = created;
  }
  res.json(user);
}));

app.get('/api/player/data/:user_id', wrap(async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, balance').eq('id', req.params.user_id).maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
}));

// UPDATED: Deposit now takes method and proof
app.post('/api/player/deposit', wrap(async (req, res) => {
  const { user_id, amount, method, proof } = req.body;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!proof) return res.status(400).json({ error: 'Transaction proof/reference is required' });

  const { error } = await supabase.from('transactions').insert({ 
    user_id, type: 'deposit', amount, status: 'pending', method, proof 
  });
  if (error) throw error;
  res.json({ message: 'Deposit request sent. Waiting for admin approval.' });
}));

// UPDATED: Withdraw now takes method and account details
app.post('/api/player/withdraw', wrap(async (req, res) => {
  const { user_id, amount, method, account_details } = req.body;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!account_details) return res.status(400).json({ error: 'Account details required' });

  const { data, error } = await supabase.rpc('request_withdrawal', {
    p_user_id: user_id, p_amount: amount, p_method: method, p_account: account_details
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Withdrawal requested.', new_balance: data.new_balance });
}));

// Note: You must update your Supabase SQL function `request_withdrawal` to accept method and account!
// Run this in Supabase SQL editor:
/*
DROP FUNCTION IF EXISTS request_withdrawal(bigint, numeric);
CREATE OR REPLACE FUNCTION request_withdrawal(p_user_id bigint, p_amount numeric, p_method text, p_account text)
RETURNS json LANGUAGE plpgsql AS $$
DECLARE v_user users;
BEGIN
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  SELECT * INTO v_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_user.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
  UPDATE users SET balance = balance - p_amount WHERE id = p_user_id;
  INSERT INTO transactions (user_id, type, amount, status, method, account_details) 
  VALUES (p_user_id, 'withdrawal', p_amount, 'pending', p_method, p_account);
  RETURN json_build_object('new_balance', v_user.balance - p_amount);
END; $$;
*/

app.post('/api/player/play', wrap(async (req, res) => {
  const { user_id, card_number } = req.body;
  const { data, error } = await supabase.rpc('place_ticket', { p_user_id: user_id, p_card_number: card_number });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: `Joined round #${data.round_id} with card ${data.card_number}.`, ...data });
}));

app.get('/api/player/round', wrap(async (req, res) => {
  const { data: round, error: rErr } = await supabase.from('rounds').select('id, status, created_at').eq('status', 'active').maybeSingle();
  if (rErr) throw rErr;
  if (!round) return res.json({ round: null, taken: [] });
  const { data: tickets, error } = await supabase.from('tickets').select('card_number').eq('round_id', round.id);
  if (error) throw error;
  res.json({ round, taken: (tickets || []).map(t => t.card_number) });
}));

app.get('/api/player/history/:user_id', wrap(async (req, res) => {
  const [tx, tickets] = await Promise.all([
    supabase.from('transactions').select('*').eq('user_id', req.params.user_id).order('created_at', { ascending: false }).limit(10),
    supabase.from('tickets').select('card_number, created_at, rounds (id, status)').eq('user_id', req.params.user_id).order('created_at', { ascending: false }).limit(10)
  ]);
  res.json({ transactions: tx.data, tickets: tickets.data });
}));

// ---------- ADMIN ROUTES ----------
app.get('/api/admin/transactions', adminOnly, wrap(async (req, res) => {
  // Added method, proof, account_details to the select
  const { data, error } = await supabase
    .from('transactions').select('id, type, amount, status, created_at, method, proof, account_details, users (name, phone)')
    .eq('status', 'pending').order('created_at', { ascending: true });
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/transaction/:id', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase.rpc('resolve_transaction', { p_tx_id: Number(req.params.id), p_action: String(req.body.action || '') });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: `Transaction ${data.status}`, ...data });
}));

app.get('/api/admin/players', adminOnly, wrap(async (req, res) => {
  const { data: round } = await supabase.from('rounds').select('id').eq('status', 'active').maybeSingle();
  if (!round) return res.json({ round: null, players: [] });
  const { data, error } = await supabase.from('tickets').select('card_number, users (name, phone)').eq('round_id', round.id).order('card_number', { ascending: true });
  res.json({ round, players: data });
}));

app.post('/api/admin/draw', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase.rpc('finish_round');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.post('/api/admin/new-round', adminOnly, wrap(async (req, res) => {
  const { data: existing } = await supabase.from('rounds').select('id').eq('status', 'active').maybeSingle();
  if (existing) return res.status(400).json({ error: 'A round is already active' });
  const { data, error } = await supabase.from('rounds').insert({ status: 'active' }).select().single();
  res.json({ message: 'New round created.', round: data });
}));

app.use((req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.path}` }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
