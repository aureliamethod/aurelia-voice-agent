/**
 * AURELIA METHOD — GROK VOICE AGENT BRIDGE SERVER
 *
 * Bridges Twilio Media Streams ↔ xAI Grok Voice Think Fast 1.0
 *
 * Architecture:
 *   Inbound/outbound Twilio call
 *     → TwiML webhook returns <Stream> pointing here
 *     → Twilio opens WebSocket to /stream
 *     → We open WebSocket to wss://api.x.ai/v1/realtime
 *     → Bidirectional mulaw audio bridge
 *     → Tool calls: send Stripe link via email, log lead to Supabase
 *
 * Deploy to Render.com (free tier) for persistent WebSocket support.
 * Netlify functions cannot host persistent WebSockets.
 *
 * Environment variables required:
 *   XAI_API_KEY         - xAI API key from console.x.ai
 *   TWILIO_ACCOUNT_SID  - Twilio account SID
 *   TWILIO_AUTH_TOKEN   - Twilio auth token
 *   TWILIO_PHONE_NUMBER - Your Twilio outbound phone number (+1XXXXXXXXXX)
 *   SUPABASE_URL        - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 *   SENDGRID_API_KEY    - SendGrid API key (for Stripe link emails)
 *   SENDGRID_FROM_EMAIL - Sender email
 *   PUBLIC_URL          - This server's public URL (e.g. https://aurelia-voice.onrender.com)
 *   NETLIFY_FUNCTIONS_URL - https://aureliamethod.com/.netlify/functions/supabase-functions
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { SESSION_CONFIG } = require('./agent-config');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/stream' });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Aurelia Method Voice Agent', model: 'grok-voice-think-fast-1.0' });
});

// ─── INBOUND CALL WEBHOOK (Twilio calls this when someone calls your number) ─
app.post('/incoming', (req, res) => {
  const callerPhone = req.body.From || 'unknown';
  console.log(`Inbound call from ${callerPhone}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/stream">
      <Parameter name="caller_phone" value="${callerPhone}"/>
      <Parameter name="call_direction" value="inbound"/>
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ─── OUTBOUND CALL WEBHOOK (Twilio calls this when we initiate an outbound call)─
app.post('/outbound-stream', (req, res) => {
  const callerPhone = req.body.To || 'unknown';
  const leadName    = req.query.lead_name || '';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/stream">
      <Parameter name="caller_phone" value="${callerPhone}"/>
      <Parameter name="lead_name" value="${leadName}"/>
      <Parameter name="call_direction" value="outbound"/>
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ─── WEBSOCKET BRIDGE ──────────────────────────────────────────────────────
wss.on('connection', (twilioWs, req) => {
  console.log('Twilio WebSocket connected');

  let grokWs       = null;
  let streamSid    = null;
  let callerPhone  = null;
  let leadName     = null;
  let callDir      = 'inbound';
  let sessionReady = false;
  const audioQueue = [];    // buffer audio before grok session is ready

  // Open Grok Voice WebSocket — URL confirmed from xAI quickstart
  grokWs = new WebSocket(
    'wss://api.x.ai/v1/realtime',
    {
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      }
    }
  );

  // ── Grok → Twilio ──────────────────────────────────────────────────────
  grokWs.on('open', () => {
    console.log('Grok Voice WebSocket connected');

    // Configure session — model goes inside session.update per xAI docs
    const sessionUpdate = {
      type: 'session.update',
      session: {
        model:                  SESSION_CONFIG.model,
        voice:                  SESSION_CONFIG.voice,
        instructions:           SESSION_CONFIG.instructions,
        turn_detection:         SESSION_CONFIG.turn_detection,
        tools:                  SESSION_CONFIG.tools,
        input_audio_format:     SESSION_CONFIG.input_audio_format,
        output_audio_format:    SESSION_CONFIG.output_audio_format,
        input_audio_transcription: { model: 'grok-2' }
      }
    };
    grokWs.send(JSON.stringify(sessionUpdate));

    // Send initial greeting after session is configured
    setTimeout(() => {
      const greeting = callDir === 'outbound' && leadName
        ? `You are calling ${leadName} about Aurelia Method. They submitted interest through the website or were referred. Start by introducing yourself as Morgan from Aurelia Method, reference that they showed interest in the transformation program, and ask what their main goal is.`
        : `Someone just called Aurelia Method's number. Greet them warmly, introduce yourself as Morgan from Aurelia Method, and ask what you can help them with today.`;

      grokWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: greeting }]
        }
      }));
      grokWs.send(JSON.stringify({ type: 'response.create' }));
      sessionReady = true;

      // Flush queued audio
      audioQueue.forEach(audioMsg => {
        if (grokWs.readyState === WebSocket.OPEN) grokWs.send(audioMsg);
      });
      audioQueue.length = 0;
    }, 500);
  });

  grokWs.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {

      // Stream audio back to Twilio
      case 'response.audio.delta':
        if (msg.delta && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: msg.delta }
          }));
        }
        break;

      // Handle tool calls
      case 'response.function_call_arguments.done':
        await handleToolCall(msg, grokWs, callerPhone, leadName);
        break;

      case 'error':
        console.error('Grok error:', msg.error);
        break;
    }
  });

  grokWs.on('close', () => console.log('Grok WebSocket closed'));
  grokWs.on('error', (err) => console.error('Grok WebSocket error:', err.message));

  // ── Twilio → Grok ──────────────────────────────────────────────────────
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'start':
        streamSid   = msg.start.streamSid;
        callerPhone = msg.start.customParameters?.caller_phone || null;
        leadName    = msg.start.customParameters?.lead_name    || null;
        callDir     = msg.start.customParameters?.call_direction || 'inbound';
        console.log(`Stream started: ${streamSid} | caller: ${callerPhone} | dir: ${callDir}`);
        break;

      case 'media':
        if (msg.media?.payload) {
          const audioMsg = JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          });
          if (sessionReady && grokWs?.readyState === WebSocket.OPEN) {
            grokWs.send(audioMsg);
          } else {
            audioQueue.push(audioMsg);
          }
        }
        break;

      case 'stop':
        console.log('Twilio stream stopped');
        if (grokWs?.readyState === WebSocket.OPEN) grokWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WebSocket disconnected');
    if (grokWs?.readyState === WebSocket.OPEN) grokWs.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WebSocket error:', err.message));
});

// ─── TOOL CALL HANDLER ──────────────────────────────────────────────────────
async function handleToolCall(msg, grokWs, callerPhone, leadName) {
  const callId = msg.call_id;
  const fnName = msg.name;
  let args;
  try { args = JSON.parse(msg.arguments); } catch { args = {}; }

  console.log(`Tool call: ${fnName}`, args);
  let result = { success: false, error: 'Unknown tool' };

  if (fnName === 'send_stripe_link') {
    result = await sendStripeLink(args);
  } else if (fnName === 'log_lead') {
    result = await logLead(args, callerPhone);
  }

  // Return result to Grok
  grokWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(result)
    }
  }));
  grokWs.send(JSON.stringify({ type: 'response.create' }));
}

// ─── SEND STRIPE LINK (via email — SMS added when Twilio is live) ────────────
async function sendStripeLink({ phone, tier, name, email }) {
  try {
    const tierLabels = {
      '30-day': '30-Day Reset ($548)',
      '60-day': '60-Day Sculpt ($897)',
      '90-day': '90-Day Total Recode (Custom)'
    };

    // Stripe payment links — set these as env vars once Stripe products are created
    const stripeLinks = {
      '30-day': process.env.STRIPE_LINK_30DAY || 'https://buy.stripe.com/aurelia-30day',
      '60-day': process.env.STRIPE_LINK_60DAY || 'https://buy.stripe.com/aurelia-60day',
      '90-day': process.env.STRIPE_LINK_90DAY || 'https://aureliamethod.com/#contact'
    };

    const link     = stripeLinks[tier] || stripeLinks['30-day'];
    const tierLabel = tierLabels[tier]  || tier;

    // If email is available, send via SendGrid
    if (email && process.env.SENDGRID_API_KEY) {
      const sg = require('@sendgrid/mail');
      sg.setApiKey(process.env.SENDGRID_API_KEY);
      await sg.send({
        to:   email,
        from: { email: process.env.SENDGRID_FROM_EMAIL || 'support@aureliamethod.com', name: 'Morgan at Aurelia Method' },
        subject: `Your Aurelia Method Enrollment Link — ${tierLabel}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
            <h2 style="color:#C9A961;">Hi ${name || 'there'},</h2>
            <p>It was great speaking with you! Here's your secure enrollment link for the <strong>${tierLabel}</strong>:</p>
            <p style="text-align:center;margin:32px 0;">
              <a href="${link}" style="background:#C9A961;color:#000;padding:16px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:18px;">
                Complete Enrollment →
              </a>
            </p>
            <p style="color:#666;font-size:14px;">This link is secure and encrypted. Once you complete checkout, your smart box will ship within 1-3 business days.</p>
            <p style="color:#666;font-size:14px;">Questions? Reply to this email or call us back anytime.</p>
            <p>— Morgan Hunt<br>Aurelia Method</p>
          </div>
        `
      });
      return { success: true, method: 'email', sent_to: email };
    }

    // If Twilio SMS is configured, send via SMS
    if (phone && process.env.TWILIO_ACCOUNT_SID) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Hi ${name || 'there'}! Here's your Aurelia Method ${tierLabel} enrollment link: ${link}\n\nQuestions? Call or text us back.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   phone
      });
      return { success: true, method: 'sms', sent_to: phone };
    }

    return { success: false, error: 'No delivery method configured (need email or Twilio SMS)' };

  } catch (err) {
    console.error('send_stripe_link error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── LOG LEAD TO SUPABASE ────────────────────────────────────────────────────
async function logLead({ name, phone, interest_level, protocol_interest, notes, callback_requested }, callerPhone) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { error } = await supabase.from('leads').upsert({
      full_name:           name || null,
      phone:               phone || callerPhone || null,
      interest_level,
      protocol_interest,
      notes:               notes || null,
      callback_requested:  callback_requested || false,
      source:              'ai_call_agent',
      last_contact_at:     new Date().toISOString(),
      assigned_rep:        'Morgan Hunt'
    }, { onConflict: 'phone' });

    if (error) {
      console.error('log_lead DB error:', error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    console.error('log_lead error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── START SERVER ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Aurelia Method Voice Agent Bridge running on port ${PORT}`);
  console.log(`Health: GET /`);
  console.log(`Inbound TwiML webhook: POST /incoming`);
  console.log(`Outbound TwiML webhook: POST /outbound-stream`);
  console.log(`Twilio WebSocket: wss://[host]/stream`);
});
