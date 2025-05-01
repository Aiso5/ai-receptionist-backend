// ai-receptionist-backend/index.js (Google Calendar with retries, status + SMS fallback)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const fs = require('fs');
const twilioLib = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// Environment variables
const BLAND_API_KEY    = process.env.BLAND_API_KEY;
const BASE_URL         = process.env.BASE_URL || 'https://ai-receptionist-backend-b7yp.onrender.com';
const CALENDAR_ID      = process.env.GOOGLE_CALENDAR_ID;
const TWILIO_SID       = process.env.TWILIO_SID;
const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
const TWILIO_NUMBER    = process.env.TWILIO_NUMBER;

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

// Twilio client for SMS fallback
const twilioClient = twilioLib(TWILIO_SID, TWILIO_TOKEN);

// 1) Inbound booking -> create calendar event with attempts counter
app.post('/check-and-book', async (req, res) => {
  const { name, phone, date, time, service = 'General' } = req.body;
  if (!name || !phone || !date || !time) {
    return res.status(400).json({ status: 'fail', message: 'Missing required fields.' });
  }
  try {
    const calendar = await getCalendar();
    const [hour, minute] = to24h(time).split(':');
    const start = `${date}T${hour}:${minute}:00`;
    const endHour = String((parseInt(hour, 10) + 1) % 24).padStart(2,'0');
    const end    = `${date}T${endHour}:${minute}:00`;

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${service} - ${name}`,
        description: `Phone: ${phone}`,
        start: { dateTime: start, timeZone: 'America/Chicago' },
        end:   { dateTime: end,   timeZone: 'America/Chicago' },
        extendedProperties: {
          private: {
            confirmationStatus: 'Pending',
            attempts: '0'
          }
        }
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
    const nowHour = new Date().getHours();
    if (nowHour < 9 || nowHour >= 18) {
      return res.status(429).send('Outside call window');
    }
    const tomorrow = getTomorrowStr();
    const calendar = await getCalendar();
    const listRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${tomorrow}T00:00:00-05:00`, timeMax: `${tomorrow}T23:59:59-05:00`,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const events = listRes.data.items || [];
    for (const ev of events) {
      const props = ev.extendedProperties?.private || {};
      if (props.confirmationStatus !== 'Pending') continue;
      const attempts = parseInt(props.attempts || '0', 10);
      if (attempts >= 2) continue;

      const desc = ev.description || '';
      const match = desc.match(/Phone:\s*(\+?\d+)/);
      const phone = match ? match[1] : null;
      if (!phone) continue;

      const [service] = ev.summary.split(' - ');
      const time12h = new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
      const task = `Hi ${service} patient, this is Mia from My Vitality Med Spa. I'm calling to confirm your ${service} appointment tomorrow at ${time12h}. If you can make it, say "yes." To cancel, say "no." To reschedule, say "reschedule."`;

      await axios.post('https://api.bland.ai/v1/calls', {
        phone_number: phone,
        voice: 'June',
        task,
        callback_url: `${BASE_URL}/handle-confirmation`,
        status_callback: `${BASE_URL}/call-status`
      }, { headers: { Authorization: `Bearer ${BLAND_API_KEY}` } });

      // log call attempt
      fs.appendFileSync('call-log.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'call-sent',
        phone,
        attempts
      }) + '\n');
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
      singleEvents: true
    });
    const ev = (listRes.data.items || []).find(e => (e.description||'').includes(phone_number) &&
      e.extendedProperties?.private?.confirmationStatus === 'Pending'
    );
    if (!ev) return res.status(404).send('Event not found');

    let status = 'Pending';
    const resp = confirmation.trim().toLowerCase();
    if (resp === 'yes')           status = 'Yes';
    else if (resp === 'no')        status = 'Cancelled';
    else if (resp === 'reschedule') status = 'Reschedule';

    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: ev.id,
      requestBody: {
        extendedProperties: {
          private: {
            ...ev.extendedProperties.private,
            confirmationStatus: status
          }
        }
      }
    });

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Confirmation handling failed');
  }
});

// 4) Call status webhook -> retry or SMS fallback
app.post('/call-status', async (req, res) => {
  const { status, phone_number } = req.body;
  console.log('🔄 Call status:', req.body);
  try {
    const tomorrow = getTomorrowStr();
    const calendar = await getCalendar();
    const listRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${tomorrow}T00:00:00-05:00`, timeMax: `${tomorrow}T23:59:59-05:00`,
      singleEvents: true
    });
    const ev = (listRes.data.items || []).find(e => (e.description||'').includes(phone_number) &&
      e.extendedProperties?.private?.confirmationStatus === 'Pending'
    );
    if (!ev) return res.sendStatus(404);

    const props = ev.extendedProperties.private;
    let attempts = parseInt(props.attempts || '0', 10);

    if ((status === 'no-answer' || status === 'busy') && attempts < 2) {
      attempts++;
      // patch attempts
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: ev.id,
        requestBody: { extendedProperties: { private: { ...props, attempts: attempts.toString() } } }
      });
      // schedule retry in 2 hours
      setTimeout(async () => {
        await axios.post('https://api.bland.ai/v1/calls', {
          phone_number,
          voice: 'June',
          task: ev.summary.includes('-') ? `You're Mia calling about your appointment via My Vitality Med Spa.` : '',
          callback_url: `${BASE_URL}/handle-confirmation`,
          status_callback: `${BASE_URL}/call-status`
        }, { headers: { Authorization: `Bearer ${BLAND_API_KEY}` } });
      }, 2 * 60 * 60 * 1000);

    } else if (status === 'no-answer' && attempts >= 2) {
      // SMS fallback
      await twilioClient.messages.create({
        to: phone_number,
        from: TWILIO_NUMBER,
        body: `Hi, we tried calling to confirm your appointment tomorrow. Reply YES to confirm, NO to cancel, or RESCHEDULE to pick a new time.`
      });
      // mark SMS sent
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: ev.id,
        requestBody: { extendedProperties: { private: { ...props, confirmationStatus: 'SMS Sent' } } }
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error in call-status:', err);
    res.status(500).send('Call status processing failed');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
