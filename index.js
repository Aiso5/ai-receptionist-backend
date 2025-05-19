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

// ─── ENV ───────────────────────────────────────────────────────────────
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_API_KEY,       // v1 key
  GHL_CALENDAR_ID,   // your “Schedule an Appointment” calendar ID
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── HELPERS ───────────────────────────────────────────────────────────
function to24h(twelveHour) {
  const [t, mod] = twelveHour.split(' ');
  let [h, m] = t.split(':').map(Number);
  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getTomorrowRange() {
  const s = new Date(), e = new Date();
  s.setDate(s.getDate() + 1); s.setHours(0,0,0,0);
  e.setDate(s.getDate());     e.setHours(23,59,59,999);
  return { startMs: s.getTime(), endMs: e.getTime() };
}

function getTodayRange() {
  const s = new Date(), e = new Date();
  s.setHours(0,0,0,0);
  e.setHours(23,59,59,999);
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

    const dRe = /^\d{4}-\d{2}-\d{2}$/,
          tRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name||!phone||!date||!time) {
      return res.status(400).json({ status:'fail', message:'Missing fields.' });
    }
    if (!dRe.test(date)) {
      return res.status(400).json({ status:'fail', message:'Date must be YYYY‑MM‑DD' });
    }
    if (!tRe.test(time)) {
      return res.status(400).json({ status:'fail', message:'Time must be H:MM AM/PM' });
    }

    // Build ISO times
    const [h24, min] = to24h(time).split(':');
    const startISO   = `${date}T${h24}:${min}:00-05:00`;
    // not actually used by v1 create, but handy if you need endTime:
    // const endISO = new Date(new Date(startISO).getTime()+60*60*1000)
    //                    .toISOString().replace('.000Z','-05:00');

    const payload = {
      calendarId:       GHL_CALENDAR_ID,
      selectedTimezone: 'America/Chicago',
      selectedSlot:     startISO,
      phone,
      name
    };

    console.log('Booking payload:', payload);
    const createRes = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}`, 'Content-Type':'application/json' } }
    );
    console.log('Created appointment:', createRes.data);

    return res.json({ status:'success', id:createRes.data.id });
  } catch (err) {
    console.error('Booking error:', err.response?.data||err);
    return res.status(500).json({ status:'error', message:'Booking failed.' });
  }
});

// ─── 2) SEND REMINDERS ─────────────────────────────────────────────────
app.post('/send-reminders', async (req, res) => {
  try {
    // allow override with ?force=true or test 'today' with ?today=true
    const hr = new Date().getHours();
    if (!req.query.force && (hr < 9 || hr >= 18)) {
      return res.status(429).send('Outside call window');
    }

    // gather appointments
    let appts = [];
    if (req.body.appointmentId) {
      const { data } = await axios.get(
        `https://rest.gohighlevel.com/v1/appointments/${req.body.appointmentId}`,
        { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
      );
      appts = [data];
    } else {
      const { startMs, endMs } = req.query.today
        ? getTodayRange()
        : getTomorrowRange();
      const listRes = await axios.get(
        'https://rest.gohighlevel.com/v1/appointments/',
        {
          headers:{ Authorization:`Bearer ${GHL_API_KEY}` },
          params:{ calendarId:GHL_CALENDAR_ID, startDate:startMs, endDate:endMs }
        }
      );
      appts = listRes.data.appointments || [];
    }

    // place calls only on new/booked
    let sent = 0;
    for (const a of appts) {
      if (!['new','booked'].includes(a.appointmentStatus)) continue;
      const phone = a.contact?.phone || a.phone;
      if (!phone) continue;

      const when = new Date(a.startTime)
        .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task = `Hi! This is Mia confirming your appointment tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;

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

    console.log(`Scheduled ${sent} reminder calls`);
    res.send(`Scheduled ${sent} reminder calls.`);
  } catch (err) {
    console.error('Reminder error:', err.response?.data||err);
    res.status(500).send('Failed to send reminders');
  }
});

// ─── 3) HANDLE CONFIRMATION ────────────────────────────────────────────
app.post('/handle-confirmation', async (req, res) => {
  try {
    const id = req.query.appt;
    if (!id) return res.status(400).send('Missing appt');
    console.log('📥 Confirmation webhook:', { query:req.query, body:req.body });

    const resp   = (req.body.confirmation||'').trim().toLowerCase();
    const status = resp === 'yes' ? 'confirmed' : 'cancelled';

    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${id}/status`,
      { status },
      {
        headers:{
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Confirm error:', err.response?.data||err);
    res.status(500).send('Confirmation failed');
  }
});

// ─── 4) CALL-STATUS → SMS FALLBACK ────────────────────────────────────
app.post('/call-status', async (req, res) => {
  const { status, phone_number } = req.body;
  try {
    if (['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to:   phone_number,
        body:'We couldn’t reach you. Reply YES to confirm, NO to cancel, RESCHEDULE to change.'
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Call-status error:', err);
    res.status(500).send('Call-status failed');
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
