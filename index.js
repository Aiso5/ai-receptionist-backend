// ai-receptionist-backend/index.js (Updated with Google Sheets Integration)
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

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

const SHEET_ID = '1KXQWB8cxNEgRrye0ShItZOWSpoQtlFw05qXoMrk-63Y';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const GOOGLE_SHEETS_CREDENTIALS = require('./google-credentials.json');

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SHEETS_CREDENTIALS,
  scopes: SCOPES,
});

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

app.post('/send-reminders', async (req, res) => {
  try {
    const appointments = await getAppointments();
    for (let i = 0; i < appointments.length; i++) {
      const [name, phone, date, time, service, sent] = appointments[i];
      if (sent?.toLowerCase() === 'yes') continue; // skip already sent

      await twilioClient.calls.create({
        twiml: `<Response><Say>Hello ${name}, this is a reminder from My Vitality Med Spa for your ${service} appointment on ${date} at ${time}.</Say></Response>`,
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
      });

      await twilioClient.messages.create({
        body: `Hi ${name}, this is My Vitality Med Spa. Just reminding you about your ${service} appointment on ${date} at ${time}. Text us to reschedule.`,
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
      });

      await markReminderSent(i);
    }

    res.send("Reminders sent.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send reminders");
  }
});

// Existing routes stay the same...
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say("Hi! Thanks for calling My Vitality Med Spa. I'm Mia, your virtual receptionist. How can I assist you today?");
  twiml.pause({ length: 2 });
  twiml.say("Please leave a message after the tone.");
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
