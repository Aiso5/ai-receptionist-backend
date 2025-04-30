// ai-receptionist-backend/index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const SHEET_ID = '1KXQWB8cxNEgRrye0ShItZOWSpoQtlFw05qXoMrk-63Y';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const GOOGLE_SHEETS_CREDENTIALS = require('./google-credentials.json');
const BLAND_API_KEY = process.env.BLAND_API_KEY;           // set in .env
const BASE_URL      = process.env.BASE_URL || 'https://ai-receptionist-backend-b7yp.onrender.com';

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SHEETS_CREDENTIALS,
  scopes: SCOPES,
});

async function getAppointments() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:F'
  });
  return res.data.values || [];
}

async function updateAppointmentStatus(rowIndex, status) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!F${rowIndex + 2}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] }
  });
}

function getTomorrowStr() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const yyyy = t.getFullYear();
  const mm   = String(t.getMonth()+1).padStart(2,'0');
  const dd   = String(t.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

// 1) Outbound reminder calls for tomorrow
app.post('/send-reminders', async (req, res) => {
  try {
    const tomorrowStr = getTomorrowStr();
    const appointments = await getAppointments();

    for (let i = 0; i < appointments.length; i++) {
      const [name, phone, date, time, service, status] = appointments[i];
      // only call tomorrow's and not-yet-confirmed
      if (date !== tomorrowStr) continue;
      if (status && status.toLowerCase() !== 'no') continue;

      await axios.post('https://api.bland.ai/v1/calls', {
        phone_number: phone,
        voice: 'June',
        task: `You're Mia from My Vitality Med Spa. I'm calling to confirm your ${service} appointment tomorrow at ${time}. If you can make it, please say "yes". If you need to cancel, say "no". If you'd like to reschedule, say "reschedule".`,
        webhook_url: `${BASE_URL}/handle-confirmation`
      }, {
        headers: {
          Authorization: `Bearer ${BLAND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      // mark as called so we don't call twice
      await updateAppointmentStatus(i, 'Called');
    }

    res.send('Outbound calls scheduled.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to send reminders');
  }
});

// 2) Handle confirmation replies from Bland’s webhook outbound calls changes made
app.post('/handle-confirmation', async (req, res) => {
  console.log('📥 Confirmation Received:', req.body);
  const { phone_number, confirmation } = req.body;
  const tomorrowStr = getTomorrowStr();
  const appointments = await getAppointments();

  // find the row by phone + date
  const idx = appointments.findIndex(
    row => row[1] === phone_number && row[2] === tomorrowStr
  );
  if (idx < 0) return res.status(404).send('Appointment not found');

  let newStatus = 'No Response';
  const resp = confirmation.trim().toLowerCase();
  if (resp === 'yes')          newStatus = 'Yes';
  else if (resp === 'no')      newStatus = 'Cancelled';
  else if (resp === 'reschedule') newStatus = 'Reschedule';

  await updateAppointmentStatus(idx, newStatus);
  res.sendStatus(200);
});

// (Optional) existing inbound/message handlers can remain or be disabled
app.post('/voice', (req, res) => {
  const { VoiceResponse } = require('twilio').twiml;
  const twiml = new VoiceResponse();
  twiml.say("Hi! Thanks for calling My Vitality Med Spa. I'm Mia, your virtual receptionist. Please leave a message.");
  twiml.record({ maxLength: 30, action: '/voice/recording' });
  res.type('text/xml'); res.send(twiml.toString());
});

app.post('/voice/recording', (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  console.log('Call recorded at:', recordingUrl);
  const { VoiceResponse } = require('twilio').twiml;
  const twiml = new VoiceResponse();
  twiml.say("Thanks! We've saved your message.");
  res.type('text/xml'); res.send(twiml.toString());
});

app.post('/sms', (req, res) => {
  const { MessagingResponse } = require('twilio').twiml;
  const twiml = new MessagingResponse();
  const msg = req.body.Body.toLowerCase();
  if (msg.includes('appointment')) twiml.message("Reply yes/no/reschedule to confirm your appointment.");
  else twiml.message("Thanks! We'll follow up soon.");
  res.type('text/xml'); res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

