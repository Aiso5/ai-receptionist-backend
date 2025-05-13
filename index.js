// ai-receptionist-backend/index.js
require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const bodyParser= require('body-parser');
const fs        = require('fs');
const twilioLib = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────
const {
  BASE_URL,
  BLAND_API_KEY,
  GHL_CALENDAR_ID,    // your “Schedule an Appointment” event calendar
  GHL_API_KEY,        // v1 key for contacts & appts
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── SERVICE → APPOINTMENT TYPE ID ────────────────────────────────────
const SERVICE_TYPE_IDS = {
  "Microneedling":        "CVV5l5hW8oQj9fCvJRQ0",
  "Hydrafacial":          "I9kLB4y6IA6gjSRhoPkE",
  "IPL Acne Treatments":  "LsUJFSftNp3F7WPgX4mZ",
  "Press Files":          "Xo5vCcfx6bWIVykhPbsH",
  "Body Contouring":      "atRqPW5SeTiOXwDx8VZx",
  "PRP Injections":       "hm9zPDrD0kh86uVaZDwW",
  "Laser Hair Removal":   "nddmesx61WaFpfrQR3ut",
  "Fillers":              "xdyndm4rMsTvh48CLRjd",
  "Body Multi Shape":     "fcs6WN0rroebbG97bitr",
  "Laser Treatments":     "ztEI8IyOTmJL7uFzRgCu"
};

// ─── HELPERS ───────────────────────────────────────────────────────────
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
  e.setDate(s.getDate());    e.setHours(23,59,59,999);
  return { startMs: s.getTime(), endMs: e.getTime() };
}

// ─── HEALTHCHECK ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.send('OK'));

// ─── CONTACT LOOKUP/CREATE (v1) ───────────────────────────────────────
async function ensureContact(phone,name) {
  // Try fetch
  let r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` }, params:{ phone } }
  );
  if (r.data.contacts?.length) return r.data.contacts[0].id;

  // Create then re-fetch
  await axios.post(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { phone, name },
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
  );
  r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{ Authorization:`Bearer ${GHL_API_KEY}` }, params:{ phone } }
  );
  return r.data.contacts[0].id;
}

// ─── 1) BOOK APPOINTMENT (v1 event calendar) ──────────────────────────
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time, service } = req.body;
    if (!service) return res.status(400).json({status:'fail',message:'Missing service.'});
    const typeId = SERVICE_TYPE_IDS[service.trim()];
    if (!typeId) return res.status(400).json({status:'fail',message:`Unknown service: ${service}`});

    // Normalize & validate
    date = Array.isArray(date) ? date.join('') : date || '';
    time = Array.isArray(time) ? time.join('') : time || '';
    date = date.trim(); time = time.trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/,
          timeRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name||!phone||!date||!time) {
      return res.status(400).json({status:'fail',message:'Missing fields.'});
    }
    if (!dateRe.test(date)) {
      return res.status(400).json({status:'fail',message:'Date must be YYYY-MM-DD'});
    }
    if (!timeRe.test(time)) {
      return res.status(400).json({status:'fail',message:'Time must be H:MM AM/PM'});
    }

    // Build ISO slot
    const [h24,min] = to24h(time).split(':');
    const isoSlot   = `${date}T${h24}:${min}:00-05:00`;

    // Fetch free slots for that day
    const startMs = new Date(`${date}T00:00:00-05:00`).getTime();
    const endMs   = new Date(`${date}T23:59:59-05:00`).getTime();
    const slotsRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/slots',
      {
        headers:{ Authorization:`Bearer ${GHL_API_KEY}` },
        params:{ calendarId:GHL_CALENDAR_ID, startDate:startMs, endDate:endMs }
      }
    );
    const daySlots = slotsRes.data[date]?.slots||[];
    if (!daySlots.includes(isoSlot)) {
      return res.status(409).json({status:'fail',message:'Time slot unavailable'});
    }

    // Ensure contact exists
    const contactId = await ensureContact(phone,name);

    // Book with appointmentTypeId
    const payload = {
      calendarId:        GHL_CALENDAR_ID,
      selectedTimezone:  'America/Chicago',
      selectedSlot:      isoSlot,
      appointmentTypeId: typeId,
      phone,
      name,
      contactId        // optional but helpful
    };
    console.log('Booking payload:',payload);

    const createRes = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
    );
    console.log('Created appointment:',createRes.data);

    return res.json({status:'success',message:'Booked!'});

  } catch(err) {
    console.error('Booking error:', err.response?.data||err);
    return res.status(500).json({status:'error',message:'Booking failed.'});
  }
});

// ─── 2) SEND REMINDERS (v1) ───────────────────────────────────────────
app.post('/send-reminders', async (req,res) => {
  const hr = new Date().getHours();
  if (hr<9||hr>=18) return res.status(429).send('Outside call window');
  try {
    const { startMs, endMs } = getTomorrowRange();
    const listRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/',
      {
        headers:{ Authorization:`Bearer ${GHL_API_KEY}` },
        params:{ calendarId:GHL_CALENDAR_ID, startDate:startMs, endDate:endMs, includeAll:true }
      }
    );
    const appts = listRes.data.appointments||[];

    for (const a of appts) {
      if (!['new','booked','confirmed'].includes(a.status||a.appointmentStatus)) continue;
      const phone = a.contact?.phone||a.phone;
      if (!phone) continue;
      const when = new Date(a.startTime)
                    .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task = `Hi ${a.title||'patient'}, this is Mia confirming your ${a.title} tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;
      await axios.post(
        'https://api.bland.ai/v1/calls',
        {
          phone_number:   phone,
          voice:          'June',
          task,
          callback_url:   `${BASE_URL}/handle-confirmation?appointmentId=${a.id}`,
          status_callback:`${BASE_URL}/call-status`
        },
        { headers:{ Authorization:`Bearer ${BLAND_API_KEY}` } }
      );
      fs.appendFileSync('call-log.json',
        JSON.stringify({ts:new Date().toISOString(),event:'call-sent',phone})+'\n'
      );
    }
    res.send('Outbound calls scheduled.');
  } catch(err) {
    console.error('Reminder error:', err.response?.data||err);
    res.status(500).send('Failed to send reminders');
  }
});

// ─── 3) HANDLE CONFIRMATION ───────────────────────────────────────────
app.post('/handle-confirmation', async (req,res) => {
  try {
    const apptId = req.query.appointmentId;
    if (!apptId) return res.status(400).send('Missing appointmentId');
    const resp = (req.body.confirmation||'').trim().toLowerCase();
    const newStatus = resp==='yes' ? 'confirmed' : 'cancelled';
    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${apptId}/status`,
      { status:newStatus },
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}` } }
    );
    return res.sendStatus(200);
  } catch(err){
    console.error('Confirmation error:', err.response?.data||err);
    res.status(500).send('Confirmation handling failed');
  }
});

// ─── 4) CALL-STATUS WEBHOOK → SMS FALLBACK ────────────────────────────
app.post('/call-status', async (req,res) => {
  const { status, phone_number } = req.body;
  try {
    if (['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to:   phone_number,
        body:'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  } catch(err){
    console.error('Call-status error:', err);
    res.status(500).send('Call status processing failed');
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT||10000;
app.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));
