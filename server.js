require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();

// Initialize Stripe with your Secret Key (Store in .env file)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase (Use SERVICE ROLE KEY for backend updates to bypass RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors({ origin: 'http://localhost:3000' })); // Allow your Next.js frontend

// Webhook requires raw body, API requires JSON
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// 1. Create Checkout Session Endpoint
app.post('/create-checkout-session', async (req, res) => {
  const { userId, email, companyName } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      client_reference_id: userId, // CRITICAL: This links the payment to the user ID
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Startup Verification: ${companyName}`,
              description: 'Official Investarise Global Event Pass & Verification',
            },
            unit_amount: 5000, // $50.00 (Amount in cents)
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      // Redirect URLs
      success_url: `${process.env.CLIENT_URL}?success=true`,
      cancel_url: `${process.env.CLIENT_URL}?canceled=true`,
      metadata: {
        company_name: companyName,
        user_id: userId
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Stripe Webhook (Handle successful payment)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`Webhook Signature Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const stripeSessionId = session.id;

    console.log(`Payment successful for User: ${userId}`);

    // Update Supabase Database
    const { error } = await supabase
      .from('founder_profiles')
      .update({
        payment_status: 'paid',
        stripe_session_id: stripeSessionId,
        paid_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating Supabase:', error);
      return res.status(500).send('Database update failed');
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));