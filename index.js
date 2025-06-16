// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const twilioLib  = require('twilio');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const {
  BASE_URL,
  BLAND_API_KEY,
  GHL_API_KEY,
  GHL_CALENDAR_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── Helper: convert "H:MM AM/PM" → "HH:MM" (24h) ────────────────────────
function to24h(twelveHour) {
  const [time, mod] = twelveHour.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ─── 0) Health-check ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('OK'));

// ─── 1) BOOKING ─────────────────────────────────────────────────────────────
app.post('/check-and-book', async (req, res) => {
  try {
    const { name, phone, date, time } = req.body;
    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: 'Missing name, phone, date or time' });
    }

    // Convert time and build Chicago-offset ISO
    const [h24, min] = to24h(time).split(':');
    const slotISO = `${date}T${h24}:${min}:00-05:00`;

    const payload = {
      calendarId:       GHL_CALENDAR_ID,
      selectedTimezone: 'America/Chicago',
      selectedSlot:     slotISO,
      phone,
      name
    };

    console.log('Booking payload:', payload);
    const createRes = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      payload,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log('Created appointment:', createRes.data);
    return res.status(201).json({ id: createRes.data.id });
  } catch (err) {
    console.error('Booking error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Booking failed' });
  }
});

// ─── 2) REMINDERS (single appointment) ────────────────────────────────────
app.post('/send-reminders', async (req, res) => {
  console.log('→ /send-reminders got:', req.body);
  try {
    const { appointmentId } = req.body;
    if (!appointmentId) {
      return res.status(400).json({ error: 'Missing appointmentId' });
    }

    // Fetch that one appointment
    const { data: appt } = await axios.get(
      `https://rest.gohighlevel.com/v1/appointments/${appointmentId}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}` } }
    );

    // Format appointment time in America/Chicago
    const when = new Date(appt.startDateTime).toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true
    });

    // Schedule Bland.ai outbound call
    await axios.post(
      'https://api.bland.ai/v1/calls',
      {
        to:               appt.contact?.phone || appt.phone,
        from:             TWILIO_PHONE_NUMBER,
        script:           `Hi ${appt.name}, this is Mia confirming your appointment tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`,
        callback_url:     `${BASE_URL}/handle-confirmation?appt=${appointmentId}`,
        status_callback:  `${BASE_URL}/call-status`
      },
      {
        headers: {
          Authorization: `Bearer ${BLAND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Reminder call scheduled for ${appointmentId} at ${when}`);
    return res.json({ message: 'Reminder call scheduled.' });
  } catch (err) {
    console.error('Error in /send-reminders:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to schedule reminder.' });
  }
});

// ─── 3) CONFIRMATION HANDLER ───────────────────────────────────────────────
app.post('/handle-confirmation', async (req, res) => {
  try {
    const appointmentId = req.query.appt;
    const confirmation  = (req.query.confirmation || '').toLowerCase();
    if (!appointmentId || !confirmation) {
      return res.status(400).json({ error: 'Missing appt or confirmation' });
    }

    const map = { yes: 'confirmed', no: 'cancelled', reschedule: 'rescheduled' };
    const status = map[confirmation];
    if (!status) {
      return res.status(400).json({ error: 'Invalid confirmation value' });
    }

    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${appointmentId}/status`,
      { status },
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Appointment ${appointmentId} set to ${status}`);
    return res.json({ message: `Appointment ${status}` });
  } catch (err) {
    console.error('Error in /handle-confirmation:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Confirmation failed' });
  }
});

// ─── 4) CALL-STATUS → SMS FALLBACK ────────────────────────────────────────
app.post('/call-status', async (req, res) => {
  console.log('→ /call-status got:', req.body);
  try {
    const { callStatus, to } = req.body;
    if (['no-answer', 'busy'].includes(callStatus)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to,
        body: 'We couldn’t reach you. Reply YES to confirm, NO to cancel, or RESCHEDULE to change.'
      });
      console.log(`SMS fallback sent to ${to}`);
    }
    return res.json({ message: 'Call status processed.' });
  } catch (err) {
    console.error('Error in /call-status:', err.message);
    return res.status(500).json({ error: 'Call-status processing failed' });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
