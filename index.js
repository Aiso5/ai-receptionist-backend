// ai-receptionist-backend/index.js (Updated with Bland AI Outbound Calls)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const { MessagingResponse, VoiceResponse } = twilio.twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const SHEET_ID = '1KXQWB8cxNEgRrye0ShItZOWSpoQtlFw05qXoMrk-63Y';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const GOOGLE_SHEETS_CREDENTIALS = require('./google-credentials.json');

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SHEETS_CREDENTIALS,
  scopes: SCOPES,
});

const BLAND_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NDU0NDIzMzgsInN1YiI6ImM1MDBhZGU3LTAyM2MtNGFkOC1hMGY0LWQ1OGQ3YTlmM2JiZCIsInVzZXJfaWQiOiJjNTAwYWRlNy0wMjNjLTRhZDgtYTBmNC1kNThkN2E5ZjNiYmQiLCJ1aWQiOiJjNTAwYWRlNy0wMjNjLTRhZDgtYTBmNC1kNThkN2E5ZjNiYmQiLCJpYXQiOjE3NDUwOTY3Mzh9.bSCoH-BhtqOmw1tPrwWEeV32Xw3gC5YLt8fltB8i7B0';

// Utility to fetch appointments
async function getAppointments() {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const range = 'Sheet1!A2:F';
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return result.data.values || [];
}

// Utility to update 'Reminder Sent' to Yes
async function markReminderSent(rowIndex) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!F${rowIndex + 2}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Yes']] },
  });
}

// Send conversational reminder calls via Bland AI
app.post('/send-reminders', async (req, res) => {
  try {
    const appointments = await getAppointments();
    for (let i = 0; i < appointments.length; i++) {
      const [name, phone, date, time, service, sent] = appointments[i];
      if (!phone || sent?.toLowerCase() === 'yes') continue;

      await axios.post("https://api.bland.ai/v1/calls", {
        phone_number: phone,
        voice: "June",
        task: `You're Mia from My Vitality Med Spa. Call ${name} to confirm their ${service} appointment on ${date} at ${time}. Ask if they'll attend, and help them reschedule if needed. Be natural, warm, and friendly.`
      }, {
        headers: {
          Authorization: `Bearer ${BLAND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      await markReminderSent(i);
    }

    res.send("Bland AI reminders sent.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send Bland AI reminders");
  }
});

// Inbound and SMS routes unchanged for now
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say("Hi! Thanks for calling My Vitality Med Spa. I'm Mia, your virtual receptionist. Please leave a message.");
  twiml.record({ maxLength: 30, action: '/voice/recording' });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/recording', (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  console.log("Call recorded at:", recordingUrl);
  const twiml = new VoiceResponse();
  twiml.say("Thanks! We've saved your message.");
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/sms', (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.toLowerCase();

  if (incomingMsg.includes('appointment')) {
    twiml.message("You can book, reschedule, or cancel. Just reply with one of those words!");
  } else if (incomingMsg.includes('facial') || incomingMsg.includes('botox')) {
    twiml.message("We offer facials, Botox, microneedling, and more!");
  } else {
    twiml.message("Thanks for contacting My Vitality Med Spa. We'll get back to you soon.");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
