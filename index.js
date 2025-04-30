// ai-receptionist-backend/index.js (Google Calendar as DB)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// Environment variables
const BLAND_API_KEY         = process.env.BLAND_API_KEY;
const BASE_URL             = process.env.BASE_URL || 'https://ai-receptionist-backend-b7yp.onrender.com';
const CALENDAR_ID          = process.env.GOOGLE_CALENDAR_ID;

// Google Auth setup
const GOOGLE_SA_CREDENTIALS = require('./google-credentials.json');
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SA_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/calendar']
});

async function getCalendar() {
  const client = await auth.getClient();
  return google.calendar({ version: 'v3', auth: client });
}

function getTomorrowStr() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const yyyy = t.getFullYear();
  const mm   = String(t.getMonth()+1).padStart(2,'0');
  const dd   = String(t.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function to24h(time12h) {
  // expects e.g. "2:00 PM"
  const [time, modifier] = time12h.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (modifier === 'PM' && h !== 12) h += 12;
  if (modifier === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// 1) Inbound booking -> create calendar event
app.post('/check-and-book', async (req, res) => {
  const { name, phone, date, time, service = 'General' } = req.body;
  if (!name || !phone || !date || !time) {
    return res.status(400).json({ status: 'fail', message: 'Missing required fields.' });
  }
  try {
    const calendar = await getCalendar();

    // convert “H:MM AM/PM” → “HH:MM”
    const [hour, minute] = to24h(time).split(':');
    // build RFC3339 timestamps with seconds
    const start = `${date}T${hour.padStart(2,'0')}:${minute}:00`;
    const endHour = String((parseInt(hour, 10) + 1) % 24).padStart(2,'0');
    const end    = `${date}T${endHour}:${minute}:00`;

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${service} - ${name}`,
        description: `Phone: ${phone}`,
        start: { dateTime: start, timeZone: 'America/Chicago' },
        end:   { dateTime: end,   timeZone: 'America/Chicago' },
        extendedProperties: { private: { confirmationStatus: 'Pending' } }
      }
    });

    res.json({ status: 'success', message: 'Appointment booked.' });
  } catch (err) {
    console.error('❌ Error in booking:', err);
    res.status(500).json({ status: 'error', message: 'Booking failed.' });
  }
});

// 2) Outbound reminder calls for tomorrow -> Bland calls
app.post('/send-reminders', async (req, res) => {
  try {
    const tomorrow = getTomorrowStr();
    const calendar = await getCalendar();
    const listRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${tomorrow}T00:00:00-05:00`, timeMax: `${tomorrow}T23:59:59-05:00`,
      singleEvents: true,
      orderBy: 'startTime',
      privateExtendedProperty: 'confirmationStatus=Pending'
    });
    const events = listRes.data.items || [];
    for (const ev of events) {
      const desc = ev.description || '';
      const match = desc.match(/Phone:\s*(\+?\d+)/);
      const phone = match ? match[1] : null;
      if (!phone) continue;
      const [service] = ev.summary.split(' - ');
      const time12h = new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
      await axios.post('https://api.bland.ai/v1/calls', {
        phone_number: phone,
        voice: 'June',
        task: `You're Mia from My Vitality Med Spa. I'm calling to confirm your ${service} tomorrow at ${time12h}. If you can make it, say "yes." To cancel, say "no." To reschedule, say "reschedule."`,
        callback_url: `${BASE_URL}/handle-confirmation`
      }, { headers: { Authorization: `Bearer ${BLAND_API_KEY}` } });
    }
    res.send('Outbound calls scheduled.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to send reminders');
  }
});

// 3) Handle confirmation replies -> patch event
app.post('/handle-confirmation', async (req, res) => {
  console.log('📥 Confirmation Received:', req.body);
  const { phone_number, confirmation } = req.body;
  try {
    const tomorrow = getTomorrowStr();
    const calendar = await getCalendar();
    const listRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${tomorrow}T00:00:00-05:00`, timeMax: `${tomorrow}T23:59:59-05:00`,
      singleEvents: true,
      privateExtendedProperty: 'confirmationStatus=Pending'
    });
    const ev = (listRes.data.items || []).find(e => (e.description||'').includes(phone_number));
    if (!ev) return res.status(404).send('Event not found');
    let status = 'Pending';
    const resp = confirmation.trim().toLowerCase();
    if (resp === 'yes')          status = 'Yes';
    else if (resp === 'no')       status = 'Cancelled';
    else if (resp === 'reschedule') status = 'Reschedule';
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: ev.id,
      requestBody: { extendedProperties: { private: { confirmationStatus: status } } }
    });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Confirmation handling failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
