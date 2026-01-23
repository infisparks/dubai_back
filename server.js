require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// --- CONFIGURATION CHECKS ---
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('CRITICAL ERROR: STRIPE_SECRET_KEY is missing in .env');
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('CRITICAL ERROR: SUPABASE credentials missing in .env');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --- CORS ---
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
    
    // Retrieve metadata
    const userType = session.metadata.user_type || 'founder'; 
    const isGala = session.metadata.is_gala === 'true'; // Founder specific
    const ticketType = session.metadata.ticket_type; // Visitor specific

    console.log(`💰 Payment success for [${userType}]: ${userId}`);

    try {
      // 1. Determine which table to update based on userType
      let tableName;
      if (userType === 'exhibitor') {
        tableName = 'exhibitor_profiles';
      } else if (userType === 'pitching') {
        tableName = 'pitching_profiles';
      } else if (userType === 'visitor') {
        tableName = 'visitor_profiles';
      } else {
        tableName = 'founder_profiles';
      }

      // 2. Check if already paid to prevent duplicate processing
      const { data: existing } = await supabase
        .from(tableName)
        .select('payment_status')
        .eq('user_id', userId)
        .single();

      if (existing && existing.payment_status === 'paid') {
        console.log('⚠️ Already paid, skipping update.');
        return res.json({ received: true });
      }

      // 3. Prepare Update Data
      const updateData = {
        payment_status: 'paid',
        stripe_session_id: stripeSessionId,
        paid_at: new Date().toISOString()
      };

      // Type-specific field updates
      if (userType === 'founder') {
        updateData.is_gala = isGala;
      } else if (userType === 'visitor' && ticketType) {
        // Ensure the database reflects the ticket type actually paid for
        updateData.ticket_type = ticketType;
      }

      // 4. Update Supabase
      const { error } = await supabase
        .from(tableName)
        .update(updateData)
        .eq('user_id', userId);

      if (error) throw error;
      console.log(`✅ ${tableName} updated successfully for user ${userId}`);

    } catch (err) {
      console.error('❌ Database Update Error:', err);
      return res.status(500).send('Database Error');
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// --- CREATE CHECKOUT SESSION ---
app.post('/create-checkout-session', async (req, res) => {
  // Added ticketType to destructuring
  const { userId, email, companyName, type, isGala, ticketType } = req.body; 

  if (!userId || !email) return res.status(400).json({ error: 'Missing data' });

  // Default values (Founder)
  let unitAmount = 50000; // $500.00 in cents
  let productName = `Startup Verification: ${companyName}`;
  let description = 'Official Investarise Global Startup Pass';
  let returnUrl = 'https://www.investariseglobal.com/founder-form';

  // --- LOGIC SWITCH BASED ON TYPE ---
  
  // 1. PITCHING ($2,500)
  if (type === 'pitching') {
    unitAmount = 250000; // $2500.00 * 100
    productName = `Pitching Slot: ${companyName}`;
    description = 'Official 10-minute Pitching Slot + Startup Pass';
    returnUrl = 'https://www.investariseglobal.com/pitching-form';
  }
  // 2. EXHIBITOR (~$2,725 / 10k AED)
  else if (type === 'exhibitor') {
    unitAmount = 272500; // ~$2,725.00 * 100
    productName = `Exhibitor Registration: ${companyName}`;
    description = 'Official Investarise Global Exhibitor Pass (approx. 10,000 AED)';
    returnUrl = 'https://www.investariseglobal.com/exhibitor-form'; 
  }
  // 3. VISITOR ($250 Standard / $500 Premium) -- NEW SECTION --
  else if (type === 'visitor') {
    returnUrl = 'https://www.investariseglobal.com/visitor-form'; // Assumed route based on naming convention
    
    if (ticketType === 'premium') {
        unitAmount = 50000; // $500.00 * 100
        productName = `Visitor Premium VIP Access: ${companyName}`; // companyName here is the Visitor Name from frontend
        description = 'Includes Gala Dinner, Lunch, Dinner, and Full Day VIP Access';
    } else {
        // Default to Standard
        unitAmount = 25000; // $250.00 * 100
        productName = `Visitor Standard Access Pass: ${companyName}`;
        description = 'Includes Lunch, Dinner, and Full Day Event Access';
    }
  }
  // 4. FOUNDER ($500 base + optional $500 Gala)
  else if (type === 'founder') {
    // Keep defaults, but check for Gala
    if (isGala) {
      unitAmount = 100000; // $1000.00 * 100
      productName = `Founder Pass + Gala Dinner: ${companyName}`;
      description = 'Official Startup Pass including Networking Gala Dinner';
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      client_reference_id: userId,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: productName,
            description: description,
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${returnUrl}?success=true`,
      cancel_url: `${returnUrl}?canceled=true`,
      metadata: {
        company_name: companyName,
        user_id: userId,
        user_type: type || 'founder', // 'founder', 'exhibitor', 'pitching', or 'visitor'
        is_gala: isGala ? 'true' : 'false',
        ticket_type: ticketType || '' // Store ticket type (standard/premium) for visitors
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
