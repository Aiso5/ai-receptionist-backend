// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const twilioLib  = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_API_KEY,
  GHL_CALENDAR_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// 1) BOOK: lookup & book a single slot in GHL
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time } = req.body;
    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: 'Missing name, phone, date or time' });
    }

    // build ISO slot in Chicago
    const iso = new Date(`${date} ${time} America/Chicago`)
      .toISOString();
    const payload = {
      calendarId:       GHL_CALENDAR_ID,
      selectedTimezone: 'America/Chicago',
      selectedSlot:     iso,
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
    res.status(201).json({ id: createRes.data.id });
  } catch (err) {
    console.error('Booking error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Booking failed' });
  }
});

// 2) REMIND: send one reminder call via Bland.ai
app.post('/send-reminders', async (req, res) => {
  try {
    const { appointmentId } = req.body;
    if (!appointmentId) {
      return res.status(400).json({ error: 'Missing appointmentId' });
    }

    // fetch appointment
    const { data: appt } = await axios.get(
      `${BASE_URL}/v1/appointments/${appointmentId}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}` } }
    );

    // format time in America/Chicago
    const when = new Date(appt.startDateTime).toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true
    });

    // schedule Bland.ai call
    await axios.post(
      'https://api.bland.ai/v1/calls',
      {
        to:               appt.phone,
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
    res.json({ message: 'Reminder call scheduled.' });
  } catch (err) {
    console.error('Error in /send-reminders:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to schedule reminder.' });
  }
});

// 3) CONFIRM: handle yes/no/reschedule from Bland.ai
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
      `${BASE_URL}/v1/appointments/${appointmentId}/status`,
      { status },
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Appointment ${appointmentId} set to ${status}`);
    res.json({ message: `Appointment ${status}` });
  } catch (err) {
    console.error('Error in /handle-confirmation:', err.response?.data || err.message);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// 4) FALLBACK: SMS when call fails (no-answer/busy)
app.post('/call-status', async (req, res) => {
  try {
    const { callStatus, to } = req.body;
    console.log('Call status webhook:', req.body);

    if (['no-answer', 'busy'].includes(callStatus)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to,
        body: 'We couldn’t reach you. Reply YES to confirm, NO to cancel, or RESCHEDULE to change.'
      });
      console.log(`SMS fallback sent to ${to}`);
    }

    res.json({ message: 'Call status processed.' });
  } catch (err) {
    console.error('Error in /call-status:', err.message);
    res.status(500).json({ error: 'Call-status processing failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
