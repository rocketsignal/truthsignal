// backend/index.js — TrueSignal API
import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import pg from 'pg';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(bodyParser.json());

app.get('/health', (req, res) => res.json({ ok: true }));

async function getLatestSignals(limit = 50) {
  const q = `
    SELECT s.*, c.coingecko_id, c.name, c.symbol
    FROM signals s
    JOIN coins c ON c.id = s.coin_id
    WHERE s.snapshot_ts = (
      SELECT max(snapshot_ts) FROM signals WHERE coin_id = s.coin_id
    )
    ORDER BY s.combined_score DESC NULLS LAST
    LIMIT $1
  `;
  const r = await pool.query(q, [limit]);
  return r.rows;
}

app.get('/api/signals/top', async (req, res) => {
  try {
    const rows = await getLatestSignals(50);
    return res.json({ paid: false, data: rows.slice(0, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/api/coin/:coingecko_id', async (req, res) => {
  try {
    const cg = req.params.coingecko_id;
    const coinRes = await pool.query(
      'SELECT id, coingecko_id, name, symbol FROM coins WHERE coingecko_id=$1',
      [cg]
    );
    if (!coinRes.rowCount) return res.status(404).json({ error: 'coin not found' });
    const coin = coinRes.rows[0];
    const history = (await pool.query(
      'SELECT * FROM signals WHERE coin_id=$1 ORDER BY snapshot_ts DESC LIMIT 200',
      [coin.id]
    )).rows;
    res.json({ coin, history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { priceId, email } = req.body;
    if (!priceId || !email) return res.status(400).json({ error: 'priceId and email required' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      customer_email: email
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook (raw body)
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email;
      const u = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      if (!u.rowCount) await pool.query('INSERT INTO users (email) VALUES ($1)', [email]);
    }
    if (event.type.startsWith('customer.subscription.')) {
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      const email = customer.email;
      const u = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      const userId = u.rowCount ? u.rows[0].id : null;
      await pool.query(`
        INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, price_tier, status, current_period_end)
        VALUES ($1,$2,$3,$4,$5,to_timestamp($6))
        ON CONFLICT (stripe_subscription_id) DO UPDATE
          SET status = EXCLUDED.status,
              current_period_end = EXCLUDED.current_period_end,
              user_id = COALESCE(EXCLUDED.user_id, subscriptions.user_id)
      `, [userId, sub.customer, sub.id, sub.items.data[0].price.id, sub.status, sub.current_period_end]);
    }
  } catch (e) {
    console.error('Webhook handling error', e);
  }
  res.json({ received: true });
});

async function seedCoins() {
  const c = await pool.query('SELECT count(*) FROM coins');
  if (parseInt(c.rows[0].count) > 0) return;
  const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
    params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 200, page: 1 }
  });
  for (const coin of resp.data) {
    await pool.query(
      'INSERT INTO coins (coingecko_id, symbol, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [coin.id, coin.symbol, coin.name]
    );
  }
  console.log('TrueSignal coin index initialized');
  console.log('Seeded coins:', resp.data.length);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`TrueSignal API listening on ${PORT}`);
  await seedCoins();
});
