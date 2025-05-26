// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const fs         = require('fs');
const twilioLib  = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ─── ENV ─────────────────────────────────────────────────────────────
const {
  BLAND_API_KEY,
  BASE_URL,        // e.g. https://ai-receptionist-backend-b7yp.onrender.com
  GHL_API_KEY,     // v1 API key
  GHL_CALENDAR_ID, // your “Schedule an Appointment” calendar ID
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── HELPERS ─────────────────────────────────────────────────────────
function to24h(t12) {
  const [t,mod] = t12.split(' ');
  let [h,m] = t.split(':').map(Number);
  if (mod==='PM' && h!==12) h+=12;
  if (mod==='AM' && h===12) h=0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function getTomorrowRange() {
  const s = new Date(), e = new Date();
  s.setDate(s.getDate()+1); s.setHours(0,0,0,0);
  e.setDate(s.getDate());   e.setHours(23,59,59,999);
  return { startMs: s.getTime(), endMs: e.getTime() };
}

// ─── 1) BOOKING ───────────────────────────────────────────────────────
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time } = req.body;
    if (Array.isArray(date)) date = date.join('');
    if (Array.isArray(time)) time = time.join('');
    date = (date||'').trim();
    time = (time||'').trim();

    // validations
    if (!name||!phone||!date||!time)
      return res.status(400).json({ status:'fail', message:'Missing fields.' });

    const dRe = /^\d{4}-\d{2}-\d{2}$/, tRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!dRe.test(date)) return res.status(400).json({ status:'fail', message:'Date must be YYYY‑MM‑DD' });
    if (!tRe.test(time)) return res.status(400).json({ status:'fail', message:'Time must be H:MM AM/PM' });

    // build ISO datetimes
    const [h24, min] = to24h(time).split(':');
    const startISO = `${date}T${h24}:${min}:00-05:00`;

    // create via v1
    const payload = {
      calendarId:       GHL_CALENDAR_ID,
      selectedTimezone: 'America/Chicago',
      selectedSlot:     startISO,
      phone,
      name
    };
    console.log('▶️ Booking payload:', payload);

    const createRes = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}`, 'Content-Type':'application/json' } }
    );

    console.log('✅ Created appointment:', createRes.data);
    res.json({ status:'success', id:createRes.data.id });

  } catch(err) {
    console.error('❌ Booking error:', err.response?.data || err.message);
    res.status(500).json({ status:'error', message:'Booking failed.' });
  }
});

// ─── 2) SEND REMINDERS ─────────────────────────────────────────────────
app.post('/send-reminders', async (req, res) => {
  try {
    // allow weekends or force override
    const hr = new Date().getHours();
    if (!req.query.force && (hr<9||hr>=18)) {
      console.log('⏰ Outside call window:', hr);
      return res.status(429).send('Outside call window');
    }

    // single appointment via webhook?
    let appts = [];
    if (req.body.appointmentId) {
      console.log('🔔 send-reminders for single ID:', req.body.appointmentId);
      const r = await axios.get(
        `https://rest.gohighlevel.com/v1/appointments/${req.body.appointmentId}`,
        { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
      );
      appts = [ r.data ];
    } else {
      // list tomorrow’s
      const { startMs,endMs } = getTomorrowRange();
      console.log(`🔍 Listing appts from ${new Date(startMs)} → ${new Date(endMs)}`);
      const listRes = await axios.get(
        'https://rest.gohighlevel.com/v1/appointments/',
        {
          headers:{ Authorization:`Bearer ${GHL_API_KEY}` },
          params:{ calendarId:GHL_CALENDAR_ID, startDate:startMs, endDate:endMs }
        }
      );
      appts = listRes.data.appointments||[];
    }
    console.log(`📋 Fetched ${appts.length} appointment(s)`);

    // dial each “new” (pending confirm)
    let sent = 0;
    for (const a of appts) {
      console.log('▶️ Considering appt:', a.id, 'status:', a.appointmentStatus);
      if (a.appointmentStatus !== 'new') continue;
      const phone = a.contact?.phone || a.phone;
      if (!phone) { console.log('   ✖︎ no phone, skip'); continue; }
      const when = new Date(a.startTime)
        .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task = `Hi! confirming your appointment tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;

      console.log('☎️  Calling', phone, 'appt:', a.id);
      await axios.post(
        'https://api.bland.ai/v1/calls',
        {
          phone_number:    phone,
          voice:           'June',
          task,
          callback_url:    `${BASE_URL}/handle-confirmation?appt=${a.id}`,
          status_callback: `${BASE_URL}/call-status`
        },
        { headers:{ Authorization:`Bearer ${BLAND_API_KEY}` } }
      );

      sent++;
      fs.appendFileSync('call-log.json',
        JSON.stringify({ ts:new Date().toISOString(), event:'call-sent', phone, appt:a.id }) + '\n'
      );
    }

    console.log(`🎉 Scheduled ${sent} reminder call(s)`);
    res.send(`Scheduled ${sent} reminder call(s).`);

  } catch(err) {
    console.error('❌ Reminder error:', err.response?.data || err.message);
    res.status(500).send('Failed to send reminders');
  }
});

// ─── 3) HANDLE CONFIRMATION ────────────────────────────────────────────
app.post('/handle-confirmation', async (req,res) => {
  console.log('🔔 /handle-confirmation hit:', {
    query: req.query,
    body:  req.body
  });

  try {
    const id = req.query.appt;
    if (!id) return res.status(400).send('Missing appt query');

    const resp = (req.body.confirmation||'').trim().toLowerCase();
    const newStatus = (resp==='yes' ? 'confirmed' : 'cancelled');
    console.log(`   → Updating appt ${id} → ${newStatus}`);

    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${id}/status`,
      { status:newStatus },
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
    );

    res.sendStatus(200);
  } catch(err) {
    console.error('❌ Confirm error:', err.response?.data || err.message);
    res.status(500).send('Confirmation failed');
  }
});

// ─── 4) CALL‐STATUS → SMS FALLBACK ────────────────────────────────────
app.post('/call-status', async (req,res) => {
  console.log('🔔 /call-status hit:', req.body);
  try {
    const { status, phone_number } = req.body;
    if (['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to:   phone_number,
        body:'We couldn’t reach you. Reply YES to confirm, NO to cancel, or RESCHEDULE to change.'
      });
    }
    res.sendStatus(200);
  } catch(err) {
    console.error('❌ Call-status error:', err);
    res.status(500).send('Call-status failed');
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Server running on ${PORT}`));
