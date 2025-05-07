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
  Microneedling:    GHL_TYPE_MICRONEEDLING_ID,
  Facial:           GHL_TYPE_FACIAL_ID,
  BodyContouring:   GHL_TYPE_BODYCONTOURING_ID,
  PRPInjections:    GHL_TYPE_PRP_INJECTIONS_ID,
  LaserHairRemoval: GHL_TYPE_LASER_HAIR_REMOVAL_ID
};

// Twilio SMS client
const twilioClient = twilioLib(TWILIO_SID, TWILIO_TOKEN);

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

    // Validation
    const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name || !phone || !date || !time) {
      return res.status(400).json({ status: 'fail', message: 'Missing fields.' });
    }
    if (!dateRe.test(date)) {
      return res.status(400).json({ status: 'fail', message: 'Date must be YYYY‑MM‑DD' });
    }
    if (!timeRe.test(time)) {
      return res.status(400).json({ status: 'fail', message: 'Time must be H:MM AM/PM' });
    }

    // Build ISO slot with timezone offset
    const [h24, min] = to24h(time).split(':');
    const isoSlot = `${date}T${h24}:${min}:00-05:00`;

    // Define day boundaries
    const startOfDay = new Date(`${date}T00:00:00-05:00`).getTime();
    const endOfDay   = new Date(`${date}T23:59:59-05:00`).getTime();

    // Fetch available slots
    const slotsRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/slots',
      {
        headers: { Authorization: `Bearer ${GHL_API_KEY}` },
        params:  { calendarId: GHL_CALENDAR_ID, startDate: startOfDay, endDate: endOfDay }
      }
    );
    console.log('Slots fetched:', slotsRes.data);

    // Extract slots array for the given date
    const daySlots = slotsRes.data[date]?.slots;
    if (!daySlots || !daySlots.includes(isoSlot)) {
      return res.status(409).json({ status: 'fail', message: 'Selected time slot unavailable' });
    }

    // Use ISO string as slotId
    const slotId = isoSlot;

    // Build booking payload
    const bookPayload = {
      calendarId: GHL_CALENDAR_ID,
      slotId:     slotId,
      phone,
      name,
      title:      service,
      ...(SERVICE_TYPE_IDS[service] && { appointmentTypeId: SERVICE_TYPE_IDS[service] })
    };

    // Book the appointment
    await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      bookPayload,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    return res.json({ status: 'success', message: 'Appointment booked in GHL.' });
  } catch (err) {
    console.error('Booking error:', err.response?.data || err);
    return res.status(500).json({ status: 'error', message: 'Booking failed.' });
  }
});

// 2) Send reminders → Bland calls
app.post('/send-reminders', async (req, res) => {
  const hr = new Date().getHours();
  if (hr < 9 || hr >= 18) return res.status(429).send('Outside call window');
  try {
    const { startMs, endMs } = getTomorrowRange();
    const listRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/',
      {
        headers: { Authorization: `Bearer ${GHL_API_KEY}` },
        params:  { startDate: startMs, endDate: endMs, calendarId: GHL_CALENDAR_ID, includeAll: true }
      }
    );
    for (const a of listRes.data.appointments || []) {
      if (!['booked','confirmed'].includes(a.appointmentStatus)) continue;
      const phone = a.contact?.phone || a.phone;
      if (!phone) continue;

      const when = new Date(a.startTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
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

// 3) Handle confirmations → update status & color
app.post('/handle-confirmation', async (req, res) => {
  const { phone_number, confirmation } = req.body;
  try {
    const { startMs, endMs } = getTomorrowRange();
    const apptsRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/',
      {
        headers: { Authorization: `Bearer ${GHL_API_KEY}` },
        params:  { startDate: startMs, endDate: endMs, calendarId: GHL_CALENDAR_ID, includeAll: true }
      }
    );
    const appt = (apptsRes.data.appointments || []).find(a => (a.contact?.phone || a.phone) === phone_number);
    if (!appt) return res.status(404).send('Appointment not found');

    const resp = confirmation.trim().toLowerCase();
    const status = resp === 'yes' ? 'confirmed' : 'cancelled';

    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${appt.id}/status`,
      { status },
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
    );
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

// 4) Call status → SMS fallback
app.post('/call-status', async (req, res) => {
  const { status, phone_number } = req.body;
  try {
    if (['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_NUMBER,
        to:   phone_number,
        body: 'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Call-status error:', err);
    res.status(500).send('Call status processing failed');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
