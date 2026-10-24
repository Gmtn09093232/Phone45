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

// ---- Auto-draw config ----
const AUTO_DRAW_ENABLED = String(process.env.AUTO_DRAW_ENABLED || 'true').toLowerCase() === 'true';
const AUTO_DRAW_MIN_MINUTES = Number(process.env.AUTO_DRAW_MIN_MINUTES || 30);
const AUTO_DRAW_MIN_TICKETS = Number(process.env.AUTO_DRAW_MIN_TICKETS || 3);
const FULL_BOARD_COOLDOWN_SEC = Number(process.env.FULL_BOARD_COOLDOWN_SEC || 60);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function adminOnly(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------- STATIC ----------
app.get(['/', '/player', '/player.html'], (req, res) => res.sendFile(path.join(__dirname, 'player.html')));
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/health', (req, res) => res.json({
  ok: true,
  autoDraw: AUTO_DRAW_ENABLED,
  autoDrawMinutes: AUTO_DRAW_MIN_MINUTES,
  minTickets: AUTO_DRAW_MIN_TICKETS
}));

// ---------- HELPERS ----------
async function fetchWinners(limit) {
  const { data: rounds, error: rErr } = await supabase
    .from('rounds')
    .select('id, draw_1, draw_2, draw_3, finished_at')
    .eq('status', 'finished')
    .order('finished_at', { ascending: false })
    .limit(limit);
  if (rErr) throw rErr;
  if (!rounds || !rounds.length) return [];

  const results = [];
  for (const round of rounds) {
    const { data: allTickets, error: cErr } = await supabase
      .from('tickets').select('*', { count: 'exact' }).eq('round_id', round.id);
    if (cErr) throw cErr;
    const totalTickets = allTickets.length;
    const totalPool = totalTickets * CARD_PRICE;
    const prizes = { p1: totalPool * 0.60, p2: totalPool * 0.10, p3: totalPool * 0.05 };
    const winningNumbers = [round.draw_1, round.draw_2, round.draw_3].filter(n => n !== null);
    let winners = [];
    if (winningNumbers.length > 0) {
      const { data: tickets, error: tErr } = await supabase
        .from('tickets').select('card_number, users (name, phone)')
        .eq('round_id', round.id).in('card_number', winningNumbers);
      if (tErr) throw tErr;
      winners = tickets || [];
    }
    results.push({
      round_id: round.id,
      draw_1: round.draw_1, draw_2: round.draw_2, draw_3: round.draw_3,
      finished_at: round.finished_at,
      total_players: totalTickets, prizes, winners
    });
  }
  return results;
}

// Draw + auto-credit + auto-create-next-round (idempotent, race-safe)
async function performDrawAndCredit() {
  const { data, error } = await supabase.rpc('finish_round');
  if (error) throw new Error(error.message);

  let prizesAwarded = [];
  try {
    const { data: round } = await supabase
      .from('rounds')
      .select('id, draw_1, draw_2, draw_3, prizes_paid')
      .eq('status', 'finished')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (round && !round.prizes_paid) {
      const drawNums = [round.draw_1, round.draw_2, round.draw_3].filter(n => n != null);
      if (drawNums.length > 0) {
        const { data: allTickets } = await supabase
          .from('tickets').select('id', { count: 'exact' }).eq('round_id', round.id);
        const totalPool = (allTickets?.length || 0) * CARD_PRICE;

        const { data: winningTickets } = await supabase
          .from('tickets').select('card_number, user_id')
          .eq('round_id', round.id).in('card_number', drawNums);

        const prizeForCard = {
          [round.draw_1]: totalPool * 0.60,
          [round.draw_2]: totalPool * 0.10,
          [round.draw_3]: totalPool * 0.05
        };

        const userPrizes = {};
        (winningTickets || []).forEach(t => {
          if (t.user_id == null) return;
          const amt = prizeForCard[t.card_number] || 0;
          if (amt > 0) userPrizes[t.user_id] = (userPrizes[t.user_id] || 0) + amt;
        });

        for (const [userId, amount] of Object.entries(userPrizes)) {
          const { error: cErr } = await supabase.rpc('credit_prize', {
            p_user_id: Number(userId), p_amount: Number(amount)
          });
          if (cErr) console.error(`credit_prize failed for user ${userId}:`, cErr);
          else prizesAwarded.push({ user_id: Number(userId), amount: Number(amount) });
        }
      }
      await supabase.from('rounds').update({ prizes_paid: true }).eq('id', round.id);
    }
  } catch (e) {
    console.error('Prize crediting error:', e);
  }

  // Ensure next active round exists (race-safe)
  const { data: active } = await supabase
    .from('rounds').select('id').eq('status', 'active').maybeSingle();
  if (!active) {
    await supabase.from('rounds').insert({ status: 'active' });
  }

  return { ...data, prizes_awarded: prizesAwarded };
}

// Auto-draw engine
async function maybeAutoDraw() {
  if (!AUTO_DRAW_ENABLED) return { action: 'disabled' };

  const { data: activeRound } = await supabase
    .from('rounds').select('id, created_at').eq('status', 'active').maybeSingle();

  if (!activeRound) {
    await supabase.from('rounds').insert({ status: 'active' });
    return { action: 'created' };
  }

  const { data: tickets } = await supabase
    .from('tickets').select('created_at').eq('round_id', activeRound.id)
    .order('created_at', { ascending: true });

  const count = tickets?.length || 0;

  if (count < AUTO_DRAW_MIN_TICKETS) {
    return { action: 'waiting', reason: 'min-tickets', count, minRequired: AUTO_DRAW_MIN_TICKETS };
  }

  const qualifiedAt = new Date(tickets[AUTO_DRAW_MIN_TICKETS - 1].created_at).getTime();
  const elapsed = Date.now() - qualifiedAt;
  const isFull = count >= 100;

  const timeTrigger = elapsed >= AUTO_DRAW_MIN_MINUTES * 60000;
  const fullTrigger = isFull && elapsed >= FULL_BOARD_COOLDOWN_SEC * 1000;

  if (!timeTrigger && !fullTrigger) {
    return {
      action: 'waiting',
      reason: isFull ? 'cooldown' : 'timer',
      count, elapsedMin: Number((elapsed / 60000).toFixed(2))
    };
  }

  try {
    const result = await performDrawAndCredit();
    return { action: 'drawn', reason: isFull ? 'full' : 'time', result };
  } catch (e) {
    console.error('Auto-draw failed:', e);
    return { action: 'error', error: e.message };
  }
}

// Helper to compute countdown meta for a round
async function roundMeta(roundId) {
  const { data: tickets } = await supabase
    .from('tickets').select('created_at').eq('round_id', roundId)
    .order('created_at', { ascending: true });
  const count = tickets?.length || 0;
  const qualifiedAt = count >= AUTO_DRAW_MIN_TICKETS ? tickets[AUTO_DRAW_MIN_TICKETS - 1].created_at : null;
  const autoDrawAt = qualifiedAt
    ? new Date(new Date(qualifiedAt).getTime() + AUTO_DRAW_MIN_MINUTES * 60000).toISOString()
    : null;
  return {
    tickets_sold: count,
    min_tickets: AUTO_DRAW_MIN_TICKETS,
    qualified_at: qualifiedAt,
    auto_draw_at: autoDrawAt,
    auto_draw_minutes: AUTO_DRAW_MIN_MINUTES,
    auto_draw_enabled: AUTO_DRAW_ENABLED
  };
}

// ---------- PLAYER ROUTES ----------
app.post('/api/player/login', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Invalid phone format. Use 09... or +251...' });

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

app.post('/api/player/play', wrap(async (req, res) => {
  const { user_id, card_numbers } = req.body;
  if (!Array.isArray(card_numbers) || card_numbers.length === 0) {
    return res.status(400).json({ error: 'Select at least one card.' });
  }
  const { data, error } = await supabase.rpc('place_tickets', {
    p_user_id: user_id, p_card_numbers: card_numbers
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({
    message: `Successfully joined round #${data.round_id} with ${data.count} card(s)!`,
    ...data
  });
}));

// Round + countdown + lazy trigger
app.get('/api/player/round', wrap(async (req, res) => {
  try { await maybeAutoDraw(); } catch (e) { console.error('maybeAutoDraw:', e); }

  const { data: round, error: rErr } = await supabase
    .from('rounds').select('id, status, created_at').eq('status', 'active').maybeSingle();
  if (rErr) throw rErr;

  if (!round) return res.json({
    round: null, taken: [],
    tickets_sold: 0,
    min_tickets: AUTO_DRAW_MIN_TICKETS,
    qualified_at: null, auto_draw_at: null,
    auto_draw_minutes: AUTO_DRAW_MIN_MINUTES,
    auto_draw_enabled: AUTO_DRAW_ENABLED
  });

  const { data: tickets } = await supabase
    .from('tickets').select('card_number, user_id, created_at')
    .eq('round_id', round.id).order('created_at', { ascending: true });

  const taken = (tickets || []).map(t => t.card_number);
  const count = tickets?.length || 0;
  const qualifiedAt = count >= AUTO_DRAW_MIN_TICKETS ? tickets[AUTO_DRAW_MIN_TICKETS - 1].created_at : null;
  const autoDrawAt = qualifiedAt
    ? new Date(new Date(qualifiedAt).getTime() + AUTO_DRAW_MIN_MINUTES * 60000).toISOString()
    : null;

  res.json({
    round, taken,
    tickets_sold: count,
    unique_players: new Set((tickets || []).map(t => t.user_id)).size,
    min_tickets: AUTO_DRAW_MIN_TICKETS,
    qualified_at: qualifiedAt,
    auto_draw_at: autoDrawAt,
    auto_draw_minutes: AUTO_DRAW_MIN_MINUTES,
    auto_draw_enabled: AUTO_DRAW_ENABLED
  });
}));

app.get('/api/player/history/:user_id', wrap(async (req, res) => {
  const [tx, tickets] = await Promise.all([
    supabase.from('transactions').select('*').eq('user_id', req.params.user_id).order('created_at', { ascending: false }).limit(10),
    supabase.from('tickets').select('card_number, created_at, rounds (id, status)').eq('user_id', req.params.user_id).order('created_at', { ascending: false }).limit(10)
  ]);
  res.json({ transactions: tx.data, tickets: tickets.data });
}));

app.get('/api/player/winners', wrap(async (req, res) => {
  const results = await fetchWinners(5);
  res.json(results);
}));

app.get('/api/player/latest-finished-round', wrap(async (req, res) => {
  const { data, error } = await supabase
    .from('rounds').select('id, draw_1, draw_2, draw_3, finished_at')
    .eq('status', 'finished').order('finished_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  res.json(data || null);
}));

app.get('/api/player/win-check/:user_id/:round_id', wrap(async (req, res) => {
  const userId = Number(req.params.user_id);
  const roundId = Number(req.params.round_id);

  const { data: round, error: rErr } = await supabase
    .from('rounds').select('id, draw_1, draw_2, draw_3')
    .eq('id', roundId).eq('status', 'finished').maybeSingle();
  if (rErr) throw rErr;
  if (!round) return res.json({ won: false, amount: 0 });

  const drawNums = [round.draw_1, round.draw_2, round.draw_3].filter(n => n != null);
  if (!drawNums.length) return res.json({ won: false, amount: 0 });

  const { data: all } = await supabase.from('tickets').select('id', { count: 'exact' }).eq('round_id', roundId);
  const totalPool = (all?.length || 0) * CARD_PRICE;

  const prizeForCard = {
    [round.draw_1]: totalPool * 0.60,
    [round.draw_2]: totalPool * 0.10,
    [round.draw_3]: totalPool * 0.05
  };

  const { data: userTickets } = await supabase
    .from('tickets').select('card_number')
    .eq('round_id', roundId).eq('user_id', userId).in('card_number', drawNums);

  let amount = 0;
  (userTickets || []).forEach(t => { amount += prizeForCard[t.card_number] || 0; });
  res.json({ won: amount > 0, amount });
}));

// ---------- CRON (optional, for Vercel Pro or external scheduler) ----------
app.get('/api/cron/auto-draw', async (req, res) => {
  const auth = req.headers.authorization || '';
  const provided = auth.replace(/^Bearer\s+/i, '') || req.query.key;
  const valid = [process.env.CRON_SECRET, process.env.ADMIN_KEY].filter(Boolean);
  if (!valid.includes(provided)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await maybeAutoDraw();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ADMIN ROUTES ----------
app.get('/api/admin/winners', adminOnly, wrap(async (req, res) => {
  res.json(await fetchWinners(10));
}));

app.get('/api/admin/transactions', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase
    .from('transactions').select('id, type, amount, status, created_at, method, proof, account_details, users (name, phone)')
    .eq('status', 'pending').order('created_at', { ascending: true });
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/transaction/:id', adminOnly, wrap(async (req, res) => {
  const { data, error } = await supabase.rpc('resolve_transaction', {
    p_tx_id: Number(req.params.id), p_action: String(req.body.action || '')
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: `Transaction ${data.status}`, ...data });
}));

// Admin players list + countdown + lazy trigger
app.get('/api/admin/players', adminOnly, wrap(async (req, res) => {
  try { await maybeAutoDraw(); } catch (e) { console.error('maybeAutoDraw:', e); }

  const { data: round } = await supabase
    .from('rounds').select('id, created_at').eq('status', 'active').maybeSingle();

  if (!round) return res.json({
    round: null, players: [],
    tickets_sold: 0, min_tickets: AUTO_DRAW_MIN_TICKETS,
    qualified_at: null, auto_draw_at: null,
    auto_draw_minutes: AUTO_DRAW_MIN_MINUTES,
    auto_draw_enabled: AUTO_DRAW_ENABLED
  });

  const { data: players } = await supabase
    .from('tickets').select('card_number, users (name, phone)')
    .eq('round_id', round.id).order('card_number', { ascending: true });

  const meta = await roundMeta(round.id);
  res.json({ round, players: players || [], ...meta });
}));

app.post('/api/admin/draw', adminOnly, wrap(async (req, res) => {
  const result = await performDrawAndCredit();
  res.json(result);
}));

app.post('/api/admin/new-round', adminOnly, wrap(async (req, res) => {
  const { data: existing } = await supabase
    .from('rounds').select('id, created_at').eq('status', 'active').maybeSingle();
  if (existing) return res.json({ message: 'A round is already active.', round: existing });
  const { data, error } = await supabase.from('rounds').insert({ status: 'active' }).select().single();
  if (error) throw error;
  res.json({ message: 'New round created.', round: data });
}));

// ---------- 404 & ERRORS ----------
app.use((req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.path}` }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT} | Auto-draw: ${AUTO_DRAW_ENABLED} (${AUTO_DRAW_MIN_MINUTES}min, min ${AUTO_DRAW_MIN_TICKETS} tickets)`));
