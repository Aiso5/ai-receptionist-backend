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

// Env vars
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_API_KEY,
  GHL_CALENDAR_ID,
  TWILIO_SID,
  TWILIO_TOKEN,
  TWILIO_NUMBER,
  GHL_TYPE_MICRONEEDLING_ID,
  GHL_TYPE_FACIAL_ID,
  GHL_TYPE_BODYCONTOURING_ID,
  GHL_TYPE_PRP_INJECTIONS_ID,
  GHL_TYPE_LASER_HAIR_REMOVAL_ID
} = process.env;


// Map your Med‑Spa services → GHL Appointment Type IDs
const SERVICE_TYPE_IDS = {
  GHL_TYPE_MICRONEEDLING_ID=CVV5l5hW8oQj9fCvJRQ0, 
  GHL_TYPE_FACIAL_ID=I9kLB4y6IA6gjSRhoPkE,  
  GHL_TYPE_BODYCONTOURING_ID=atRqPW5SeTiOXwDx8VZx,  
  GHL_TYPE_PRP_INJECTIONS_ID=hm9zPDrD0kh86uVaZDvwW,  
  GHL_TYPE_LASER_HAIR_REMOVAL_ID=nddmesx61WaFpfrQR3ut  

};

// Twilio SMS client
ing const twilioClient = twilioLib(TWILIO_SID, TWILIO_TOKEN);

// Helpers
function getTomorrowRange() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
function to24h(time12h) {
  const [t, mod] = time12h.split(' ');
  let [h, m] = t.split(':').map(Number);
  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;
  return [String(h).padStart(2, '0'), String(m).padStart(2, '0')].join(':');
}

// 1) Booking → create GHL appointment
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time, service = 'General' } = req.body;
    if (Array.isArray(date)) date = date.join('');
    if (Array.isArray(time)) time = time.join('');
    date = date.trim();
    time = time.trim();

    // Basic validation
    const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name || !phone || !date || !time) {
      return res.status(400).json({ status: 'fail', message: 'Missing fields.' });
    }
    if (!dateRe.test(date)) return res.status(400).json({ status: 'fail', message: 'Date must be YYYY‑MM‑DD' });
    if (!timeRe.test(time)) return res.status(400).json({ status: 'fail', message: 'Time must be H:MM AM/PM' });

    // Build ISO slot with timezone offset
    const [h24, min] = to24h(time).split(':');
    const isoSlot = `${date}T${h24}:${min}:00-05:00`;

    // Prepare payload
    const payload = {
      calendarId:       GHL_CALENDAR_ID,
      selectedTimezone: 'America/Chicago',
      selectedSlot:     isoSlot,
      phone,
      name,
      title:            service
    };
    // Attach appointmentTypeId if configured
    if (SERVICE_TYPE_IDS[service]) {
      payload.appointmentTypeId = SERVICE_TYPE_IDS[service];
    }

    // Create in GHL
    await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    res.json({ status: 'success', message: 'Appointment booked in GHL.' });
  } catch (err) {
    console.error('Booking error:', err.response?.data || err);
    res.status(500).json({ status: 'error', message: 'Booking failed.' });
  }
});

// 2) Send reminders → list tomorrow’s GHL appts & Bland calls
app.post('/send-reminders', async (req, res) => {
  const hr = new Date().getHours();
  if (hr < 9 || hr >= 18) return res.status(429).send('Outside call window');

  try {
    const { startMs, endMs } = getTomorrowRange();
    const listRes = await axios.get('https://rest.gohighlevel.com/v1/appointments/', {
      headers: { Authorization: `Bearer ${GHL_API_KEY}` },
      params: {
        startDate:  startMs,
        endDate:    endMs,
        calendarId: GHL_CALENDAR_ID,
        includeAll: true
      }
    });
    const appts = listRes.data.appointments || [];

    for (const a of appts) {
      if (!['booked', 'confirmed'].includes(a.appointmentStatus)) continue;
      const phone = a.contact?.phone || a.phone;
      if (!phone) continue;

      const when = new Date(a.startTime)
        .toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
      const task = `Hi ${a.title} patient, this is Mia from My Vitality Med Spa confirming your ${a.title} tomorrow at ${when}. Say \"yes\" to confirm, \"no\" to cancel, or \"reschedule.\"`;

      await axios.post(
        'https://api.bland.ai/v1/calls',
        { phone_number: phone, voice: 'June', task, callback_url: `${BASE_URL}/handle-confirmation`, status_callback: `${BASE_URL}/call-status` },
        { headers: { Authorization: `Bearer ${BLAND_API_KEY}` } }
      );

      fs.appendFileSync('call-log.json', JSON.stringify({ ts: new Date().toISOString(), event: 'call-sent', phone }) + '\n');
    }

    res.send('Outbound calls scheduled.');
  } catch (err) {
    console.error('Reminder error:', err.response?.data || err);
    res.status(500).send('Failed to send reminders');
  }
});

// 3) Handle confirmations → update GHL appt status + color green on "yes"
app.post('/handle-confirmation', async (req, res) => {
  const { phone_number, confirmation } = req.body;
  try {
    const { startMs, endMs } = getTomorrowRange();
    const listRes = await axios.get('https://rest.gohighlevel.com/v1/appointments/', {
      headers: { Authorization: `Bearer ${GHL_API_KEY}` },
      params: { startDate: startMs, endDate: endMs, calendarId: GHL_CALENDAR_ID, includeAll: true }
    });
    const appts = listRes.data.appointments || [];
    const appt = appts.find(a => (a.contact?.phone || a.phone) === phone_number);
    if (!appt) return res.status(404).send('Appointment not found');

    let status = 'confirmed';
    const resp = confirmation.trim().toLowerCase();
    if (resp === 'no')           status = 'cancelled';
    else if (resp === 'reschedule') status = 'cancelled';

    // Update status
    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${appt.id}/status`,
      { status },
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    // Color it green if confirmed
    if (resp === 'yes') {
      await axios.patch(
        `https://rest.gohighlevel.com/v1/appointments/${appt.id}`,
        { colorHex: '#00FF00' },
        { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Confirmation error:', err.response?.data || err);
    res.status(500).send('Confirmation handling failed');
  }
});

// 4) Call status → SMS fallback (retry logic unchanged)
app.post('/call-status', async (req, res) => {
  const { status, phone_number } = req.body;
  try {
    if (['no-answer', 'busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_NUMBER,
        to:   phone_number,
        body:`We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.`
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Call-status error:', err);
    res.status(500).send('Call status processing failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
