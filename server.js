require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// Init Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('CRITICAL ERROR: STRIPE_SECRET_KEY is missing in .env');
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Init Supabase Admin
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('CRITICAL ERROR: SUPABASE credentials missing in .env');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// CORS Config
const allowedOrigins = [
  'http://localhost:3000',
  'https://www.investariseglobal.com',
  'https://investariseglobal.com',
  'https://invest.infispark.in'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS Policy Error'), false);
    }
    return callback(null, true);
  }
}));

// --- STRIPE WEBHOOK ---
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const stripeSessionId = session.id;
    // Check type from metadata (default to 'founder' if missing)
    const userType = session.metadata.user_type || 'founder'; 

    console.log(`💰 Payment success for ${userType}: ${userId}`);

    try {
      const tableName = userType === 'exhibitor' ? 'exhibitor_profiles' : 'founder_profiles';

      // Idempotency Check
      const { data: existing } = await supabase
        .from(tableName)
        .select('payment_status')
        .eq('user_id', userId)
        .single();

      if (existing && existing.payment_status === 'paid') {
        console.log('⚠️ Already paid, skipping update.');
        return res.json({ received: true });
      }

      // Update Database
      const { error } = await supabase
        .from(tableName)
        .update({
          payment_status: 'paid',
          stripe_session_id: stripeSessionId,
          paid_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (error) throw error;
      console.log(`✅ ${tableName} updated successfully`);

    } catch (err) {
      console.error('❌ Database Update Error:', err);
      return res.status(500).send('Database Error');
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// --- CHECKOUT ENDPOINT ---
app.post('/create-checkout-session', async (req, res) => {
  const { userId, email, companyName, type } = req.body; 

  if (!userId || !email) return res.status(400).json({ error: 'Missing data' });

  // 1 INR = 100 Paise (Stripe requires amounts in the smallest currency unit)
  let unitAmount = 100; 
  
  let productName = `Startup Verification: ${companyName}`;
  let returnUrl = 'https://www.investariseglobal.com/founder-form-page';

  if (type === 'exhibitor') {
    unitAmount = 100; // Also 1 INR for Exhibitor
    productName = `Exhibitor Registration: ${companyName}`;
    returnUrl = 'https://www.investariseglobal.com/exhibitor-form'; 
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      client_reference_id: userId,
      line_items: [{
        price_data: {
          currency: 'inr', // CHANGED FROM 'usd' TO 'inr'
          product_data: {
            name: productName,
            description: 'Official Investarise Global Event Pass',
          },
          unit_amount: unitAmount, // 100 paise = ₹1
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${returnUrl}?success=true`,
      cancel_url: `${returnUrl}?canceled=true`,
      metadata: {
        company_name: companyName,
        user_id: userId,
        user_type: type 
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));