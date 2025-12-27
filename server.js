require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 4000;

// Initialize Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('CRITICAL ERROR: STRIPE_SECRET_KEY is missing in .env');
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase Admin (Service Role)
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('CRITICAL ERROR: SUPABASE credentials missing in .env');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// --- MIDDLEWARE: CORS ---
// Updated with your specific domains
const allowedOrigins = [
  'http://localhost:3000',                // Local Development
  'https://www.investariseglobal.com',    // Main Production Frontend
  'https://investariseglobal.com',        // Production Frontend (non-www)
  'https://invest.infispark.in'           // Your other Origin
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or Stripe webhooks)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

// --- ROUTE 1: STRIPE WEBHOOK (MUST BE DEFINED BEFORE JSON PARSER) ---
// This route needs the RAW body to verify the signature.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`❌ Webhook Signature Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const stripeSessionId = session.id;

    console.log(`💰 Payment received for User ID: ${userId}`);

    try {
      // 1. IDEMPOTENCY CHECK: Check if already paid to save resources
      const { data: existingProfile, error: fetchError } = await supabase
        .from('founder_profiles')
        .select('payment_status')
        .eq('user_id', userId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') { // Ignore "Row not found" error
        console.error('Error fetching profile:', fetchError);
        throw fetchError; 
      }

      if (existingProfile && existingProfile.payment_status === 'paid') {
        console.log('⚠️ User already marked as paid. Skipping update.');
        return res.json({ received: true });
      }

      // 2. UPDATE DATABASE (Service Role bypasses RLS)
      const { error: updateError } = await supabase
        .from('founder_profiles')
        .update({
          payment_status: 'paid',
          stripe_session_id: stripeSessionId,
          paid_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('❌ Database Update Failed:', updateError);
        return res.status(500).send('Database update failed');
      }

      console.log('✅ Database updated successfully');

    } catch (err) {
      console.error('❌ Processing Error:', err);
      return res.status(500).send('Internal Server Error');
    }
  }

  // Return a 200 response to acknowledge receipt of the event
  res.json({ received: true });
});

// --- MIDDLEWARE: JSON PARSER (FOR ALL OTHER ROUTES) ---
app.use(express.json());

// --- ROUTE 2: CREATE CHECKOUT SESSION ---
app.post('/create-checkout-session', async (req, res) => {
  const { userId, email, companyName } = req.body;

  // Basic Validation
  if (!userId || !email) {
    return res.status(400).json({ error: 'Missing userId or email' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      client_reference_id: userId, // Links payment to user in Webhook
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Startup Verification: ${companyName || 'Founder'}`,
              description: 'Official Investarise Global Event Pass & Verification',
            },
            unit_amount: 5000, // $50.00 (in cents)
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      // UPDATED REDIRECT URLS
      success_url: `https://www.investariseglobal.com/founder-form-page?success=true`,
      cancel_url: `https://www.investariseglobal.com/founder-form-page?canceled=true`,
      metadata: {
        company_name: companyName,
        user_id: userId
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROUTE 3: HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Infispark Payment Server is Running 🚀');
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   - Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`   - Checkout endpoint: http://localhost:${PORT}/create-checkout-session`);
});